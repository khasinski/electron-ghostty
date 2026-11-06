// electron-ghostty native addon.
//
// One Term = libghostty-vt terminal + PTY + reader thread. PTY bytes are read and parsed on the
// reader thread and never touch JS. JS is woken (coalesced) when there is something to draw and
// pulls a render snapshot into a caller-provided Uint32Array (which may be SharedArrayBuffer-backed).
//
// Snapshot layout (u32 words):
//   [0] version (bumped on every snapshot that had changes)   [1] cols   [2] rows
//   [3] cursor x   [4] cursor y   [5] cursor flags: bit0 visible, bit1 in viewport, bits4..7 style
//   [6] default bg 0x00RRGGBB   [7] default fg   [8] cursor color (0xFFFFFFFF = none)
//   [9] dirty level (0 clean, 1 partial, 2 full)  [10] scrollback total rows  [11] viewport offset
//   [16 .. 16+rows)            per-row dirty flag (1 = row cells were rewritten in this snapshot)
//   [16+rows ..)               cells, 4 words each: codepoint, fg, bg, flags
//     flags: bits0..7 style attrs (bold, italic, faint, blink, inverse, invisible, strike, overline)
//            bits8..10 underline style, bits16..17 wide (0 narrow, 1 wide, 2 spacer tail, 3 spacer head)
//            bit24 fg explicit, bit25 bg explicit, bit26 grapheme has extra codepoints
#include <node_api.h>
#include <ghostty/vt.h>

#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <cstring>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <util.h>  // forkpty (macOS)
#else
#include <pty.h>   // forkpty (Linux, link with -lutil); UNTESTED
#endif

extern char** environ;

#define NAPI_CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, nullptr, "napi call failed: " #call); return nullptr; } } while (0)

static const size_t kHeaderWords = 16;
// Compress only when more than this many pages are hot and no input has arrived for kIdleMs, or
// unconditionally past the hard cap (bounds peak memory during a sustained flood).
static const uint64_t kHardCapHotPages = 1024;
static const int kIdleMs = 40;

struct Term {
  GhosttyTerminal t = nullptr;
  GhosttyRenderState rs = nullptr;
  GhosttyRenderStateRowIterator rows = nullptr;
  GhosttyRenderStateRowCells cells = nullptr;
  GhosttyRenderStateImageIterator imgs = nullptr;
  uint32_t cwpx = 0, chpx = 0;   // cell size in pixels (needed for Kitty graphics geometry)

  std::mutex mu;  // guards every use of t / rs / rows / cells
  uint32_t version = 0;
  uint16_t cols = 80, nrows = 24;

  int master = -1;
  pid_t pid = -1;
  std::thread reader;   // PTY -> buffers
  std::thread parser;   // buffers -> libghostty (overlaps with reads)
  struct Buf { std::vector<uint8_t> data; size_t len = 0; };
  std::mutex qmu;
  std::condition_variable qcv;
  std::deque<Buf*> filled;
  std::vector<Buf*> freeBufs;
  std::vector<Buf*> allBufs;
  bool eof = false;
  // instrumentation
  std::atomic<uint64_t> parseNs{0}, readNs{0}, readWaitNs{0}, reads{0}, bytes{0}, handoffs{0};
  std::atomic<bool> stop{false};
  std::atomic<bool> wakePending{false};
  std::atomic<bool> closed{false};
  napi_threadsafe_function tsfn = nullptr;
  std::atomic<int> clipPolicy{0};   // 0 = deny OSC 52 writes (default), 1 = allow
  int exitStatus = 0;
};

// ---- lifecycle -------------------------------------------------------------------------------

static void term_close(Term* term) {
  if (term->closed.exchange(true)) return;
  term->stop = true;
  if (term->pid > 0) kill(term->pid, SIGHUP);
  if (term->master >= 0) { close(term->master); term->master = -1; }
  { std::lock_guard<std::mutex> lk(term->qmu); }
  term->qcv.notify_all();
  if (term->reader.joinable()) term->reader.join();
  if (term->parser.joinable()) term->parser.join();
  for (auto* b : term->allBufs) delete b;
  term->allBufs.clear(); term->freeBufs.clear(); term->filled.clear();
  if (term->pid > 0) { int st; waitpid(term->pid, &st, WNOHANG); term->pid = -1; }
  if (term->tsfn) { napi_release_threadsafe_function(term->tsfn, napi_tsfn_abort); term->tsfn = nullptr; }
  if (term->imgs) { ghostty_render_state_image_iterator_free(term->imgs); term->imgs = nullptr; }
  if (term->cells) ghostty_render_state_row_cells_free(term->cells);
  if (term->rows) ghostty_render_state_row_iterator_free(term->rows);
  if (term->rs) ghostty_render_state_free(term->rs);
  if (term->t) ghostty_terminal_free(term->t);
  term->cells = nullptr; term->rows = nullptr; term->rs = nullptr; term->t = nullptr;
}

static void finalize(napi_env, void* data, void*) {
  Term* term = static_cast<Term*>(data);
  term_close(term);
  delete term;
}

static Term* unwrap(napi_env env, napi_value v) {
  void* p = nullptr;
  if (napi_get_value_external(env, v, &p) != napi_ok || !p) {
    napi_throw_type_error(env, nullptr, "expected terminal handle");
    return nullptr;
  }
  Term* t = static_cast<Term*>(p);
  if (t->closed.load()) { napi_throw_error(env, nullptr, "terminal is closed"); return nullptr; }
  return t;
}

struct Msg { int kind; std::string text; };

static void post(Term* term, int kind, std::string text = std::string()) {
  if (!term->tsfn) return;
  Msg* m = new Msg{kind, std::move(text)};
  if (napi_call_threadsafe_function(term->tsfn, m, napi_tsfn_nonblocking) != napi_ok) delete m;
}

// OSC 52 write request. Runs inside vt_write on the parser thread, VT stream paused; must reply synchronously.
// Default policy is DENY: a program in the terminal must not silently overwrite the user's clipboard.
static void on_clipboard_write(GhosttyTerminal, void* userdata, const GhosttyClipboardWrite* w) {
  Term* term = static_cast<Term*>(userdata);
  GhosttyClipboardWriteReply reply = GHOSTTY_INIT_SIZED(GhosttyClipboardWriteReply);
  reply.result = GHOSTTY_CLIPBOARD_WRITE_RESULT_DENIED;
  if (term->clipPolicy.load() == 1 && w->location == GHOSTTY_CLIPBOARD_LOCATION_STANDARD && w->contents_len > 0) {
    for (size_t i = 0; i < w->contents_len; i++) {
      const GhosttyClipboardContent& c = w->contents[i];
      std::string mime((const char*)c.mime.ptr, c.mime.len);
      if ((mime == "text/plain" || mime == "text/plain;charset=utf-8") && c.data.len <= (1u << 20)) {
        post(term, 2, std::string((const char*)c.data.ptr, c.data.len));
        reply.result = GHOSTTY_CLIPBOARD_WRITE_RESULT_SUCCESS;
        break;
      }
    }
  }
  w->reply(w, &reply);
}

// Terminal asks to answer on the PTY (DSR, DA, mode queries...). Runs inside vt_write, lock held.
static void on_write_pty(GhosttyTerminal, void* userdata, const uint8_t* data, size_t len) {
  Term* term = static_cast<Term*>(userdata);
  if (term->master < 0) return;
  while (len > 0) {
    ssize_t n = write(term->master, data, len);
    if (n < 0) { if (errno == EINTR) continue; return; }
    data += n; len -= (size_t)n;
  }
}

static uint64_t hot_pages(Term* term) {
  GhosttyTerminalMemoryUsage u = GHOSTTY_INIT_SIZED(GhosttyTerminalMemoryUsage);
  if (ghostty_terminal_get(term->t, GHOSTTY_TERMINAL_DATA_MEMORY_USAGE, &u) != GHOSTTY_SUCCESS) return 0;
  uint64_t pages = u.primary_pages + u.alternate_pages;
  uint64_t comp = u.primary_compressed_pages + u.alternate_compressed_pages;
  return pages > comp ? pages - comp : 0;
}

static void compress_drain(Term* term) {
  GhosttyTerminalCompressionResult r;
  do {
    r = GHOSTTY_TERMINAL_COMPRESSION_RESULT_COMPLETE;
    if (ghostty_terminal_compress(term->t, GHOSTTY_TERMINAL_COMPRESSION_MODE_INCREMENTAL, &r) != GHOSTTY_SUCCESS) return;
  } while (r == GHOSTTY_TERMINAL_COMPRESSION_RESULT_PENDING);
}

// Called on the JS thread: kind 0 = data ready, 1 = child exited, 2 = OSC 52 clipboard write (text).
static void call_js(napi_env env, napi_value js_cb, void* ctx, void* data) {
  Term* term = static_cast<Term*>(ctx);
  Msg* m = static_cast<Msg*>(data);
  if (m && m->kind == 0) term->wakePending = false;
  if (env && js_cb && m) {
    napi_value undefined, args[3];
    napi_get_undefined(env, &undefined);
    napi_create_int32(env, (int32_t)m->kind, &args[0]);
    napi_create_int32(env, term->exitStatus, &args[1]);
    if (m->kind == 2) napi_create_string_utf8(env, m->text.data(), m->text.size(), &args[2]); else napi_get_undefined(env, &args[2]);
    napi_call_function(env, undefined, js_cb, 3, args, nullptr);
  }
  delete m;
}

static const size_t kBufSize = 256 * 1024;
static const int kCoalesceUs = 500;  // flood batching window; adds <= 0.5 ms only while data streams continuously
static const int kNumBufs = 8;   // bounded queue: ~2 MB in flight, then the PTY applies backpressure

// Thread 1: PTY -> buffers. Only reads; never touches libghostty.
static void reader_main(Term* term) {
  using clock = std::chrono::steady_clock;
  auto lastHandoff = clock::now();
  while (!term->stop.load()) {
    Term::Buf* b = nullptr;
    {
      std::unique_lock<std::mutex> lk(term->qmu);
      auto w0 = std::chrono::steady_clock::now();
      term->qcv.wait(lk, [&] { return term->stop.load() || !term->freeBufs.empty(); });
      term->readWaitNs += std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - w0).count();
      if (term->stop.load()) break;
      b = term->freeBufs.back(); term->freeBufs.pop_back();
    }
    // Master fd is non-blocking. The PTY returns ~1 KB per read, so syscall count dominates:
    // read in a tight loop until the buffer is full or the PTY is drained (EAGAIN), and only then
    // block in poll(). That is one syscall per KB instead of poll+read pairs.
    size_t len = 0;
    ssize_t n = 1;           // > 0 while the fd is alive; 0 = EOF or error
    while (!term->stop.load()) {
      ssize_t r = read(term->master, b->data.data() + len, b->data.size() - len);
      term->reads++;
      if (r > 0) { len += (size_t)r; if (len == b->data.size()) break; continue; }
      if (r < 0 && errno == EINTR) continue;
      if (r < 0 && errno == EAGAIN) {
        if (len > 0) {
          // Rate-adaptive coalescing: if we handed over very recently we are in a flood, so keep
          // topping up this buffer for up to kCoalesceUs; otherwise (typing, prompts) hand over now.
          if (clock::now() - lastHandoff < std::chrono::microseconds(kCoalesceUs) && len < b->data.size() / 2) {
            sched_yield();   // not nanosleep: macOS sleeps >> 50 us and the PTY buffer fills, stalling the writer
            continue;
          }
          break;
        }
        struct pollfd pfd = {term->master, POLLIN, 0};
        poll(&pfd, 1, 200);
        continue;
      }
      n = 0; break;                              // EOF (r == 0) or EIO when the child exits
    }
    if (term->stop.load()) n = 0;
    if (len > 0) n = (ssize_t)len;
    std::lock_guard<std::mutex> lk(term->qmu);
    if (n <= 0) { term->freeBufs.push_back(b); term->eof = true; term->qcv.notify_all(); break; }
    b->len = len; term->filled.push_back(b); lastHandoff = clock::now();
    term->qcv.notify_all();
  }
  std::lock_guard<std::mutex> lk(term->qmu);
  term->eof = true; term->qcv.notify_all();
}

// Thread 2: buffers -> libghostty, wake JS, compress when idle.
static void parser_main(Term* term) {
  uint64_t lastActivity = 0;
  unsigned writes = 0;
  bool dirtyCold = false;  // hot pages exist that idle compression has not seen yet
  for (;;) {
    Term::Buf* b = nullptr;
    bool idle = false, finished = false;
    {
      std::unique_lock<std::mutex> lk(term->qmu);
      auto ready = [&] { return term->stop.load() || !term->filled.empty() || term->eof; };
      if (dirtyCold) { if (!term->qcv.wait_for(lk, std::chrono::milliseconds(kIdleMs), ready)) idle = true; }
      else term->qcv.wait(lk, ready);
      if (term->stop.load()) return;
      if (!idle) {
        if (!term->filled.empty()) { b = term->filled.front(); term->filled.pop_front(); }
        else if (term->eof) finished = true;
      }
    }
    if (idle) {
      std::lock_guard<std::mutex> lk(term->mu);
      if (term->t) {
        uint64_t act = 0;
        ghostty_terminal_compression_activity(term->t, &act);
        if (act != lastActivity) lastActivity = act;
        compress_drain(term);
      }
      dirtyCold = false;
      continue;
    }
    if (finished) break;
    {
      std::lock_guard<std::mutex> lk(term->mu);
      if (!term->t) return;
      auto p0 = std::chrono::steady_clock::now();
      ghostty_terminal_vt_write(term->t, b->data.data(), b->len);
      term->parseNs += std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - p0).count();
      term->bytes += b->len; term->handoffs++;
      if ((++writes & 31) == 0 && hot_pages(term) > kHardCapHotPages) compress_drain(term);
    }
    { std::lock_guard<std::mutex> lk(term->qmu); term->freeBufs.push_back(b); }
    term->qcv.notify_all();
    dirtyCold = true;
    if (!term->wakePending.exchange(true)) post(term, 0);
  }
  if (!term->stop.load()) {
    int st = 0;
    if (term->pid > 0 && waitpid(term->pid, &st, 0) > 0) {
      term->exitStatus = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
      term->pid = -1;
    }
    post(term, 1);
  }
}

// ---- JS API ----------------------------------------------------------------------------------

// create(cols, rows, scrollbackMaxBytes, scrollbackMaxLines?) -> handle
static napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  uint32_t cols, rows; double maxBytes;
  NAPI_CHECK(napi_get_value_uint32(env, argv[0], &cols));
  NAPI_CHECK(napi_get_value_uint32(env, argv[1], &rows));
  NAPI_CHECK(napi_get_value_double(env, argv[2], &maxBytes));
  Term* term = new Term();
  term->cols = (uint16_t)cols; term->nrows = (uint16_t)rows;
  if (ghostty_terminal_new(nullptr, &term->t, term->cols, term->nrows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(nullptr, &term->rs) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(nullptr, &term->rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(nullptr, &term->cells) != GHOSTTY_SUCCESS) {
    term_close(term); delete term;
    napi_throw_error(env, nullptr, "libghostty allocation failed");
    return nullptr;
  }
  size_t mb = (size_t)maxBytes;
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &mb);
  if (argc > 3) {
    double maxLines = 0;
    if (napi_get_value_double(env, argv[3], &maxLines) == napi_ok && maxLines > 0) {
      size_t ml = (size_t)maxLines;
      ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &ml);
    }
  }
  uint64_t kittyLimit = 64ull << 20;   // Kitty image storage: 64 MB per terminal
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT, &kittyLimit);
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_USERDATA, term);
  GhosttyTerminalWritePtyFn fn = on_write_pty;
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_WRITE_PTY, (const void*)fn);
  GhosttyTerminalClipboardWriteFn cw = on_clipboard_write;
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE, (const void*)cw);
  napi_value ext;
  NAPI_CHECK(napi_create_external(env, term, finalize, nullptr, &ext));
  return ext;
}

// spawn(handle, file, argsArray, cwd|null, onEvent(kind, status))
static napi_value Spawn(napi_env env, napi_callback_info info) {
  size_t argc = 5; napi_value argv[5];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  if (term->master >= 0) { napi_throw_error(env, nullptr, "already spawned"); return nullptr; }

  auto str = [&](napi_value v) { size_t n = 0; napi_get_value_string_utf8(env, v, nullptr, 0, &n);
    std::string s(n, '\0'); napi_get_value_string_utf8(env, v, &s[0], n + 1, &n); return s; };
  std::string file = str(argv[1]);
  std::vector<std::string> args{file};
  uint32_t alen = 0; napi_get_array_length(env, argv[2], &alen);
  for (uint32_t i = 0; i < alen; i++) { napi_value e; napi_get_element(env, argv[2], i, &e); args.push_back(str(e)); }
  std::string cwd; napi_valuetype vt; napi_typeof(env, argv[3], &vt);
  if (vt == napi_string) cwd = str(argv[3]);

  // Everything the child needs is prepared before fork (only async-signal-safe calls after it).
  std::vector<char*> cargv; for (auto& a : args) cargv.push_back(const_cast<char*>(a.c_str())); cargv.push_back(nullptr);
  std::vector<std::string> envs; std::vector<char*> cenvp;
  for (char** e = environ; *e; e++) {
    if (!strncmp(*e, "TERM=", 5) || !strncmp(*e, "COLORTERM=", 10) || !strncmp(*e, "TERM_PROGRAM=", 13)) continue;
    envs.push_back(*e);
  }
  envs.push_back("TERM=xterm-256color"); envs.push_back("COLORTERM=truecolor"); envs.push_back("TERM_PROGRAM=electron-ghostty");
  for (auto& e : envs) cenvp.push_back(const_cast<char*>(e.c_str())); cenvp.push_back(nullptr);

  struct winsize ws = {term->nrows, term->cols, 0, 0};
  int master = -1;
  pid_t pid = forkpty(&master, nullptr, nullptr, &ws);
  if (pid < 0) { napi_throw_error(env, nullptr, "forkpty failed"); return nullptr; }
  if (pid == 0) {
    if (!cwd.empty()) { if (chdir(cwd.c_str()) != 0) _exit(127); }
    execve(cargv[0][0] == '/' ? cargv[0] : (std::string("/usr/bin/env")).c_str(), cargv.data(), cenvp.data());
    // Not an absolute path: retry through env's PATH lookup.
    std::vector<char*> viaEnv{const_cast<char*>("env")};
    for (char* a : cargv) if (a) viaEnv.push_back(a);
    viaEnv.push_back(nullptr);
    execve("/usr/bin/env", viaEnv.data(), cenvp.data());
    _exit(127);
  }
  term->master = master; term->pid = pid;
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);

  napi_value name; napi_create_string_utf8(env, "ghostty-pty", NAPI_AUTO_LENGTH, &name);
  NAPI_CHECK(napi_create_threadsafe_function(env, argv[4], nullptr, name, 0, 1, nullptr, nullptr, term, call_js, &term->tsfn));
  napi_unref_threadsafe_function(env, term->tsfn);  // a live terminal must not keep Node alive by itself
  for (int i = 0; i < kNumBufs; i++) { auto* b = new Term::Buf(); b->data.resize(kBufSize); term->allBufs.push_back(b); term->freeBufs.push_back(b); }
  term->parser = std::thread(parser_main, term);
  term->reader = std::thread(reader_main, term);
  napi_value out; napi_create_int32(env, pid, &out);
  return out;
}

static void scroll_to_bottom(Term* term);
// input(handle, Buffer)  -- keystrokes / paste to the child
static napi_value Input(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  void* data = nullptr; size_t len = 0;
  NAPI_CHECK(napi_get_buffer_info(env, argv[1], &data, &len));
  const uint8_t* p = static_cast<const uint8_t*>(data);
  if (len > 0) scroll_to_bottom(term);
  while (len > 0 && term->master >= 0) {
    ssize_t n = write(term->master, p, len);
    if (n < 0) { if (errno == EINTR) continue; if (errno == EAGAIN) { usleep(200); continue; } break; }
    p += n; len -= (size_t)n;
  }
  return nullptr;
}

// write(handle, Buffer) -- feed VT bytes directly (tests / no PTY)
static napi_value Write(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  void* data = nullptr; size_t len = 0;
  NAPI_CHECK(napi_get_buffer_info(env, argv[1], &data, &len));
  std::lock_guard<std::mutex> lk(term->mu);
  ghostty_terminal_vt_write(term->t, static_cast<const uint8_t*>(data), len);
  return nullptr;
}

// resize(handle, cols, rows)
static napi_value Resize(napi_env env, napi_callback_info info) {
  size_t argc = 5; napi_value argv[5];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  uint32_t cols, rows;
  NAPI_CHECK(napi_get_value_uint32(env, argv[1], &cols));
  NAPI_CHECK(napi_get_value_uint32(env, argv[2], &rows));
  std::lock_guard<std::mutex> lk(term->mu);
  uint32_t cw = term->cwpx, ch = term->chpx;
  if (argc > 4) { napi_get_value_uint32(env, argv[3], &cw); napi_get_value_uint32(env, argv[4], &ch); }
  term->cwpx = cw; term->chpx = ch;
  term->cols = (uint16_t)cols; term->nrows = (uint16_t)rows;
  ghostty_terminal_resize(term->t, term->cols, term->nrows, cw, ch);
  if (term->master >= 0) { struct winsize ws = {term->nrows, term->cols, (unsigned short)(term->cols * cw), (unsigned short)(term->nrows * ch)}; ioctl(term->master, TIOCSWINSZ, &ws); }
  return nullptr;
}

// scroll(handle, deltaRows)  -- negative = up into history
static napi_value Scroll(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  int32_t delta; NAPI_CHECK(napi_get_value_int32(env, argv[1], &delta));
  GhosttyTerminalScrollViewport b = {};
  b.tag = GHOSTTY_TERMINAL_SCROLL_VIEWPORT_DELTA;
  b.value.delta = delta;
  std::lock_guard<std::mutex> lk(term->mu);
  ghostty_terminal_scroll_viewport(term->t, b);
  return nullptr;
}

static inline uint32_t rgb(GhosttyColorRgb c) { return ((uint32_t)c.r << 16) | ((uint32_t)c.g << 8) | c.b; }

// snapshot(handle, Uint32Array out) -> dirty level (0 clean, 1 partial, 2 full)
static napi_value Snapshot(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  napi_typedarray_type ta; size_t words; void* raw; napi_value ab; size_t off;
  NAPI_CHECK(napi_get_typedarray_info(env, argv[1], &ta, &words, &raw, &ab, &off));
  if (ta != napi_uint32_array) { napi_throw_type_error(env, nullptr, "expected Uint32Array"); return nullptr; }
  uint32_t* out = static_cast<uint32_t*>(raw);

  std::lock_guard<std::mutex> lk(term->mu);
  size_t need = kHeaderWords + term->nrows + (size_t)term->nrows * term->cols * 4;
  if (words < need) { napi_throw_range_error(env, nullptr, "snapshot buffer too small"); return nullptr; }

  if (ghostty_render_state_update(term->rs, term->t) != GHOSTTY_SUCCESS) { napi_throw_error(env, nullptr, "render_state_update failed"); return nullptr; }
  GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  ghostty_render_state_get(term->rs, GHOSTTY_RENDER_STATE_DATA_DIRTY, &dirty);

  uint32_t level = (uint32_t)dirty;
  if (dirty != GHOSTTY_RENDER_STATE_DIRTY_FALSE) {
    GhosttyRenderStateColors colors = GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
    ghostty_render_state_get(term->rs, GHOSTTY_RENDER_STATE_DATA_COLORS, &colors);
    GhosttyRenderStateCursor cur = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
    ghostty_render_state_get(term->rs, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cur);

    out[0] = ++term->version; out[1] = term->cols; out[2] = term->nrows;
    out[3] = cur.viewport_x; out[4] = cur.viewport_y;
    out[5] = (cur.visible ? 1u : 0u) | (cur.viewport_has_value ? 2u : 0u) | ((uint32_t)cur.visual_style << 4);
    out[6] = rgb(colors.background); out[7] = rgb(colors.foreground);
    out[8] = colors.cursor_has_value ? rgb(colors.cursor) : 0xFFFFFFFFu;
    out[9] = level;
    GhosttyTerminalScrollbar sb = {};
    if (ghostty_terminal_get(term->t, GHOSTTY_TERMINAL_DATA_SCROLLBAR, &sb) == GHOSTTY_SUCCESS) { out[10] = (uint32_t)sb.total; out[11] = (uint32_t)sb.offset; }

    uint32_t* rowFlags = out + kHeaderWords;
    uint32_t* cellsOut = rowFlags + term->nrows;
    memset(rowFlags, 0, term->nrows * sizeof(uint32_t));

    ghostty_render_state_get(term->rs, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &term->rows);
    uint16_t y = 0;
    while (ghostty_render_state_row_iterator_next_dirty(term->rows, &y)) {
      if (y >= term->nrows) continue;
      rowFlags[y] = 1;
      if (ghostty_render_state_row_get(term->rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &term->cells) != GHOSTTY_SUCCESS) continue;
      uint32_t* c = cellsOut + (size_t)y * term->cols * 4;
      GhosttyRenderStateRowSelection rsel = GHOSTTY_INIT_SIZED(GhosttyRenderStateRowSelection);
      bool hasSel = ghostty_render_state_row_get(term->rows, GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION, &rsel) == GHOSTTY_SUCCESS;
      uint16_t x = 0;
      while (x < term->cols && ghostty_render_state_row_cells_next(term->cells)) {
        GhosttyCell raw = 0;
        uint32_t cp = 0, flags = 0, fg = 0, bg = 0;
        GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
        bool styled = false;
        if (ghostty_render_state_row_cells_get(term->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw) == GHOSTTY_SUCCESS) {
          ghostty_cell_get(raw, GHOSTTY_CELL_DATA_CODEPOINT, &cp);
          ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
          ghostty_cell_get(raw, GHOSTTY_CELL_DATA_HAS_STYLING, &styled);
        }
        if (styled) {
          GhosttyStyle st;
          if (ghostty_render_state_row_cells_get(term->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &st) == GHOSTTY_SUCCESS)
            flags |= (uint32_t)(st.flags & 0x7FF);  // attrs + underline style share the low 11 bits
          GhosttyColorRgb col;
          if (ghostty_render_state_row_cells_get(term->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &col) == GHOSTTY_SUCCESS) { fg = rgb(col); flags |= 1u << 24; }
          if (ghostty_render_state_row_cells_get(term->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &col) == GHOSTTY_SUCCESS) { bg = rgb(col); flags |= 1u << 25; }
        }
        flags |= ((uint32_t)wide & 3u) << 16;
        if (hasSel && x >= rsel.start_x && x <= rsel.end_x) flags |= 1u << 27;
        c[0] = cp; c[1] = fg; c[2] = bg; c[3] = flags;
        c += 4; x++;
      }
      for (; x < term->cols; x++, c += 4) { c[0] = 0; c[1] = 0; c[2] = 0; c[3] = 0; }
    }
    ghostty_render_state_clean(term->rs);
  }
  napi_value r; napi_create_uint32(env, level, &r);
  return r;
}

// memory(handle) -> { resident, virtual, pages, compressedPages }
static napi_value Memory(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  GhosttyTerminalMemoryUsage u = GHOSTTY_INIT_SIZED(GhosttyTerminalMemoryUsage);
  { std::lock_guard<std::mutex> lk(term->mu);
    if (ghostty_terminal_get(term->t, GHOSTTY_TERMINAL_DATA_MEMORY_USAGE, &u) != GHOSTTY_SUCCESS) {
      napi_throw_error(env, nullptr, "memory usage unavailable"); return nullptr; } }
  napi_value o, v;
  NAPI_CHECK(napi_create_object(env, &o));
  auto set = [&](const char* k, double d) { napi_create_double(env, d, &v); napi_set_named_property(env, o, k, v); };
  set("resident", (double)(u.primary_resident_bytes + u.alternate_resident_bytes));
  set("virtual", (double)(u.primary_virtual_bytes + u.alternate_virtual_bytes));
  set("pages", (double)(u.primary_pages + u.alternate_pages));
  set("compressedPages", (double)(u.primary_compressed_pages + u.alternate_compressed_pages));
  return o;
}

// compress(handle, full:boolean) -> 0 unsupported | 1 pending | 2 complete
static napi_value Compress(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  bool full = false;
  if (argc > 1) napi_get_value_bool(env, argv[1], &full);
  GhosttyTerminalCompressionResult r = GHOSTTY_TERMINAL_COMPRESSION_RESULT_UNSUPPORTED;
  { std::lock_guard<std::mutex> lk(term->mu);
    ghostty_terminal_compress(term->t,
        full ? GHOSTTY_TERMINAL_COMPRESSION_MODE_FULL : GHOSTTY_TERMINAL_COMPRESSION_MODE_INCREMENTAL, &r); }
  napi_value out; napi_create_int32(env, (int)r, &out);
  return out;
}


// ---- input encoding, mouse, selection, theme -------------------------------------------------

static void pty_write(Term* term, const uint8_t* p, size_t len) {
  while (len > 0 && term->master >= 0) {
    ssize_t n = write(term->master, p, len);
    if (n < 0) { if (errno == EINTR) continue; if (errno == EAGAIN) { usleep(100); continue; } return; }
    p += n; len -= (size_t)n;
  }
}

static void scroll_to_bottom(Term* term) {
  GhosttyTerminalScrollViewport b = {};
  b.tag = GHOSTTY_TERMINAL_SCROLL_VIEWPORT_BOTTOM;
  std::lock_guard<std::mutex> lk(term->mu);
  ghostty_terminal_scroll_viewport(term->t, b);
}

// key(handle, keyCode, mods, action(0 release,1 press,2 repeat), utf8|null, unshiftedCp, composing) -> bytes written
static napi_value Key(napi_env env, napi_callback_info info) {
  size_t argc = 7; napi_value argv[7];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  uint32_t code, mods, action, unshifted = 0; bool composing = false;
  NAPI_CHECK(napi_get_value_uint32(env, argv[1], &code));
  NAPI_CHECK(napi_get_value_uint32(env, argv[2], &mods));
  NAPI_CHECK(napi_get_value_uint32(env, argv[3], &action));
  std::string utf8; napi_valuetype vt; napi_typeof(env, argv[4], &vt);
  if (vt == napi_string) { size_t n = 0; napi_get_value_string_utf8(env, argv[4], nullptr, 0, &n); utf8.resize(n); napi_get_value_string_utf8(env, argv[4], &utf8[0], n + 1, &n); }
  napi_get_value_uint32(env, argv[5], &unshifted);
  if (argc > 6) napi_get_value_bool(env, argv[6], &composing);

  GhosttyKeyEncoder enc = nullptr; GhosttyKeyEvent ev = nullptr;
  uint8_t buf[128]; size_t written = 0;
  if (ghostty_key_encoder_new(nullptr, &enc) != GHOSTTY_SUCCESS) return nullptr;
  if (ghostty_key_event_new(nullptr, &ev) != GHOSTTY_SUCCESS) { ghostty_key_encoder_free(enc); return nullptr; }
  ghostty_key_event_set_action(ev, (GhosttyKeyAction)action);
  ghostty_key_event_set_key(ev, (GhosttyKey)code);
  ghostty_key_event_set_mods(ev, (GhosttyMods)mods);
  if (!utf8.empty()) {
    GhosttyString str = {(const uint8_t*)utf8.data(), utf8.size()};
    ghostty_key_event_set_utf8(ev, str);
    ghostty_key_event_set_consumed_mods(ev, (GhosttyMods)(mods & GHOSTTY_MODS_SHIFT));
  }
  ghostty_key_event_set_unshifted_codepoint(ev, unshifted);
  ghostty_key_event_set_composing(ev, composing);
  {
    std::lock_guard<std::mutex> lk(term->mu);   // encoder reads live terminal modes (DECCKM, kitty flags...)
    ghostty_key_encoder_set_from_terminal(enc, term->t);
    ghostty_key_encoder_encode(enc, ev, buf, sizeof buf, &written);
  }
  if (written > 0 && written <= sizeof buf) { pty_write(term, buf, written); if (action != 0) scroll_to_bottom(term); }
  ghostty_key_event_free(ev); ghostty_key_encoder_free(enc);
  napi_value out; napi_create_uint32(env, (uint32_t)written, &out);
  return out;
}

// mouse(handle, action 0 press/1 release/2 motion, button 0..11, mods, px, py, screenW, screenH, cellW, cellH, anyPressed)
//   -> 1 if the terminal consumed it (mouse tracking on: reported to the program), else 0
static napi_value Mouse(napi_env env, napi_callback_info info) {
  size_t argc = 11; napi_value argv[11];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  uint32_t action, button, mods, sw, sh, cw, ch; double px, py; bool any = false;
  NAPI_CHECK(napi_get_value_uint32(env, argv[1], &action)); NAPI_CHECK(napi_get_value_uint32(env, argv[2], &button));
  NAPI_CHECK(napi_get_value_uint32(env, argv[3], &mods));
  NAPI_CHECK(napi_get_value_double(env, argv[4], &px)); NAPI_CHECK(napi_get_value_double(env, argv[5], &py));
  NAPI_CHECK(napi_get_value_uint32(env, argv[6], &sw)); NAPI_CHECK(napi_get_value_uint32(env, argv[7], &sh));
  NAPI_CHECK(napi_get_value_uint32(env, argv[8], &cw)); NAPI_CHECK(napi_get_value_uint32(env, argv[9], &ch));
  napi_get_value_bool(env, argv[10], &any);

  bool tracking = false;
  uint8_t buf[64]; size_t written = 0; bool consumed = false;
  {
    std::lock_guard<std::mutex> lk(term->mu);
    ghostty_terminal_get(term->t, GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &tracking);
    if (tracking) {
      GhosttyMouseEncoder enc = nullptr; GhosttyMouseEvent ev = nullptr;
      if (ghostty_mouse_encoder_new(nullptr, &enc) == GHOSTTY_SUCCESS && ghostty_mouse_event_new(nullptr, &ev) == GHOSTTY_SUCCESS) {
        ghostty_mouse_encoder_set_from_terminal(enc, term->t);
        GhosttyMouseEncoderSize sz = GHOSTTY_INIT_SIZED(GhosttyMouseEncoderSize);
        sz.screen_width = sw; sz.screen_height = sh; sz.cell_width = cw; sz.cell_height = ch;
        ghostty_mouse_encoder_set(enc, GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &sz);
        ghostty_mouse_encoder_set(enc, GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, &any);
        bool track = true; ghostty_mouse_encoder_set(enc, GHOSTTY_MOUSE_ENCODER_OPT_TRACK_LAST_CELL, &track);
        ghostty_mouse_event_set_action(ev, (GhosttyMouseAction)action);
        if (button) ghostty_mouse_event_set_button(ev, (GhosttyMouseButton)button); else ghostty_mouse_event_clear_button(ev);
        ghostty_mouse_event_set_mods(ev, (GhosttyMods)mods);
        GhosttyMousePosition pos = {(float)px, (float)py};
        ghostty_mouse_event_set_position(ev, pos);
        ghostty_mouse_encoder_encode(enc, ev, buf, sizeof buf, &written);
        consumed = true;   // tracking is on: the program owns the mouse even if this event encodes to nothing
      }
      if (ev) ghostty_mouse_event_free(ev);
      if (enc) ghostty_mouse_encoder_free(enc);
    }
  }
  if (written > 0 && written <= sizeof buf) pty_write(term, buf, written);
  napi_value out; napi_get_boolean(env, consumed, &out);
  return out;
}

static bool viewport_ref(Term* term, uint32_t x, uint32_t y, GhosttyGridRef* ref) {
  GhosttyPoint pt = {};
  pt.tag = GHOSTTY_POINT_TAG_VIEWPORT;
  pt.value.coordinate.x = (uint16_t)x; pt.value.coordinate.y = y;
  *ref = {}; return ghostty_terminal_grid_ref(term->t, pt, ref) == GHOSTTY_SUCCESS;
}

// select(handle, mode, x1, y1, x2, y2): 0 drag (anchor 1 -> cell 2), 1 word at 1, 2 line at 1, 3 all, 4 clear
// -> true if a selection exists afterwards
static napi_value Select(napi_env env, napi_callback_info info) {
  size_t argc = 6; napi_value argv[6];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  uint32_t mode, x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  NAPI_CHECK(napi_get_value_uint32(env, argv[1], &mode));
  if (argc > 5) { napi_get_value_uint32(env, argv[2], &x1); napi_get_value_uint32(env, argv[3], &y1); napi_get_value_uint32(env, argv[4], &x2); napi_get_value_uint32(env, argv[5], &y2); }
  std::lock_guard<std::mutex> lk(term->mu);
  GhosttySelection sel = {}; bool have = false;
  GhosttyGridRef a, b;
  if (mode == 0 && viewport_ref(term, x1, y1, &a) && viewport_ref(term, x2, y2, &b)) { sel.start = a; sel.end = b; sel.rectangle = false; have = true; }
  else if (mode == 1 && viewport_ref(term, x1, y1, &a)) {
    GhosttyTerminalSelectWordOptions o = GHOSTTY_INIT_SIZED(GhosttyTerminalSelectWordOptions); o.ref = a;
    have = ghostty_terminal_select_word(term->t, &o, &sel) == GHOSTTY_SUCCESS;
  } else if (mode == 2 && viewport_ref(term, x1, y1, &a)) {
    GhosttyTerminalSelectLineOptions o = GHOSTTY_INIT_SIZED(GhosttyTerminalSelectLineOptions); o.ref = a;
    have = ghostty_terminal_select_line(term->t, &o, &sel) == GHOSTTY_SUCCESS;
  } else if (mode == 3) have = ghostty_terminal_select_all(term->t, &sel) == GHOSTTY_SUCCESS;
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_SELECTION, have ? (const void*)&sel : nullptr);
  napi_value out; napi_get_boolean(env, have, &out);
  return out;
}

// selectionText(handle) -> string | null
static napi_value SelectionText(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  std::lock_guard<std::mutex> lk(term->mu);
  GhosttySelection sel = {};
  napi_value out; napi_get_null(env, &out);
  if (ghostty_terminal_get(term->t, GHOSTTY_TERMINAL_DATA_SELECTION, &sel) != GHOSTTY_SUCCESS) return out;
  GhosttyFormatter f = nullptr;
  if (ghostty_formatter_terminal_new(nullptr, &f, term->t) != GHOSTTY_SUCCESS) return out;
  GhosttyFormatterFormat emit = GHOSTTY_FORMATTER_FORMAT_PLAIN; bool trim = true;
  ghostty_formatter_set(f, GHOSTTY_FORMATTER_OPT_EMIT, &emit);
  ghostty_formatter_set(f, GHOSTTY_FORMATTER_OPT_TRIM, &trim);
  ghostty_formatter_set(f, GHOSTTY_FORMATTER_OPT_SELECTION, &sel);
  uint8_t* buf = nullptr; size_t len = 0;
  if (ghostty_formatter_format_alloc(f, nullptr, &buf, &len) == GHOSTTY_SUCCESS && buf) {
    napi_create_string_utf8(env, (const char*)buf, len, &out);
    ghostty_free(nullptr, buf, len);
  }
  ghostty_formatter_free(f);
  return out;
}

// setTheme(handle, fg, bg, cursor, Uint32Array(256) palette as 0xRRGGBB)
static napi_value SetTheme(napi_env env, napi_callback_info info) {
  size_t argc = 5; napi_value argv[5];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  uint32_t fg, bg, cur;
  NAPI_CHECK(napi_get_value_uint32(env, argv[1], &fg)); NAPI_CHECK(napi_get_value_uint32(env, argv[2], &bg)); NAPI_CHECK(napi_get_value_uint32(env, argv[3], &cur));
  napi_typedarray_type ta; size_t n; void* raw; napi_value ab; size_t off;
  NAPI_CHECK(napi_get_typedarray_info(env, argv[4], &ta, &n, &raw, &ab, &off));
  if (ta != napi_uint32_array || n < 256) { napi_throw_type_error(env, nullptr, "palette must be Uint32Array(256)"); return nullptr; }
  auto col = [](uint32_t v) { GhosttyColorRgb c; c.r = (v >> 16) & 255; c.g = (v >> 8) & 255; c.b = v & 255; return c; };
  GhosttyColorRgb pal[256]; const uint32_t* p = static_cast<const uint32_t*>(raw);
  for (int i = 0; i < 256; i++) pal[i] = col(p[i]);
  GhosttyColorRgb cfg = col(fg), cbg = col(bg), ccur = col(cur);
  std::lock_guard<std::mutex> lk(term->mu);
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &cfg);
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &cbg);
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &ccur);
  ghostty_terminal_set(term->t, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, pal);
  return nullptr;
}


// paste(handle, string) -> 0 ok | 1 rejected as unsafe (e.g. embedded control sequences) | 2 nothing
// Honors bracketed paste mode (2004) and refuses text that could inject commands.
static napi_value Paste(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  size_t n = 0; napi_get_value_string_utf8(env, argv[1], nullptr, 0, &n);
  std::string text(n, '\0'); napi_get_value_string_utf8(env, argv[1], &text[0], n + 1, &n);
  int rc = 2;
  if (n > 0) {
    bool bracketed = false;
    { std::lock_guard<std::mutex> lk(term->mu);
      GhosttyTerminalModeConfig mc = {GHOSTTY_MODE_BRACKETED_PASTE, false};
      if (ghostty_terminal_get(term->t, GHOSTTY_TERMINAL_DATA_MODE, &mc) == GHOSTTY_SUCCESS) bracketed = mc.value; }
    if (!ghostty_paste_is_safe(text.data(), text.size()) && !bracketed) rc = 1;
    else {
      size_t need = 0;
      ghostty_paste_encode(&text[0], text.size(), bracketed, nullptr, 0, &need);
      std::vector<uint8_t> out(need ? need : text.size() + 16);
      size_t written = 0;
      if (ghostty_paste_encode(&text[0], text.size(), bracketed, out.data(), out.size(), &written) == GHOSTTY_SUCCESS && written > 0) { pty_write(term, out.data(), written); scroll_to_bottom(term); rc = 0; }
    }
  }
  napi_value out; napi_create_int32(env, rc, &out);
  return out;
}


// setClipboardPolicy(handle, 0 deny | 1 allow) -- OSC 52 writes from programs in the terminal
static napi_value SetClipboardPolicy(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  int32_t v = 0; napi_get_value_int32(env, argv[1], &v);
  term->clipPolicy = v ? 1 : 0;
  return nullptr;
}

// hyperlinkAt(handle, x, y) -> OSC 8 URI of the viewport cell, or null
static napi_value HyperlinkAt(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  uint32_t x, y; NAPI_CHECK(napi_get_value_uint32(env, argv[1], &x)); NAPI_CHECK(napi_get_value_uint32(env, argv[2], &y));
  napi_value out; napi_get_null(env, &out);
  std::lock_guard<std::mutex> lk(term->mu);
  GhosttyGridRef ref;
  if (!viewport_ref(term, x, y, &ref)) return out;
  size_t len = 0;
  GhosttyResult r = ghostty_grid_ref_hyperlink_uri(&ref, nullptr, 0, &len);
  if (r == GHOSTTY_OUT_OF_SPACE && len > 0 && len < 8192) {
    std::vector<uint8_t> buf(len);
    if (ghostty_grid_ref_hyperlink_uri(&ref, buf.data(), buf.size(), &len) == GHOSTTY_SUCCESS && len > 0)
      napi_create_string_utf8(env, (const char*)buf.data(), len, &out);
  }
  return out;
}

// images(handle, knownGen) -> null if the placement list is unchanged since knownGen, else
// { gen, list: Float64Array(n * 14) } with per item:
// imageId, imageGen, layer, z, col, row, offX, offY, pw, ph, sx, sy, sw, sh  (all in pixels / cells, viewport relative)
// Reads the state of the last snapshot() call.
static napi_value Images(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  double known = 0; napi_get_value_double(env, argv[1], &known);
  napi_value out; napi_get_null(env, &out);
  std::lock_guard<std::mutex> lk(term->mu);
  uint64_t gen = 0;
  if (ghostty_render_state_get(term->rs, GHOSTTY_RENDER_STATE_DATA_IMAGE_PLACEMENTS_GENERATION, &gen) != GHOSTTY_SUCCESS) return out;
  if ((double)gen == known) return out;
  if (!term->imgs && ghostty_render_state_image_iterator_new(nullptr, &term->imgs) != GHOSTTY_SUCCESS) return out;
  if (ghostty_render_state_get(term->rs, GHOSTTY_RENDER_STATE_DATA_IMAGE_ITERATOR, &term->imgs) != GHOSTTY_SUCCESS) return out;
  std::vector<double> v;
  while (ghostty_render_state_image_iterator_next(term->imgs)) {
    uint32_t id = 0, layer = 0, gc = 0, gr = 0, ox = 0, oy = 0, pw = 0, ph = 0, sx = 0, sy = 0, sw = 0, sh = 0; uint64_t ig = 0; int32_t z = 0, col = 0, row = 0;
    auto g = [&](GhosttyRenderStateImageData d, void* o) { return ghostty_render_state_image_get(term->imgs, d, o) == GHOSTTY_SUCCESS; };
    if (!g(GHOSTTY_RENDER_STATE_IMAGE_DATA_IMAGE_ID, &id)) continue;
    g(GHOSTTY_RENDER_STATE_IMAGE_DATA_IMAGE_GENERATION, &ig); g(GHOSTTY_RENDER_STATE_IMAGE_DATA_LAYER, &layer); g(GHOSTTY_RENDER_STATE_IMAGE_DATA_Z, &z);
    g(GHOSTTY_RENDER_STATE_IMAGE_DATA_VIEWPORT_COL, &col); g(GHOSTTY_RENDER_STATE_IMAGE_DATA_VIEWPORT_ROW, &row);
    g(GHOSTTY_RENDER_STATE_IMAGE_DATA_CELL_OFFSET_X, &ox); g(GHOSTTY_RENDER_STATE_IMAGE_DATA_CELL_OFFSET_Y, &oy);
    g(GHOSTTY_RENDER_STATE_IMAGE_DATA_PIXEL_WIDTH, &pw); g(GHOSTTY_RENDER_STATE_IMAGE_DATA_PIXEL_HEIGHT, &ph);
    g(GHOSTTY_RENDER_STATE_IMAGE_DATA_SOURCE_X, &sx); g(GHOSTTY_RENDER_STATE_IMAGE_DATA_SOURCE_Y, &sy);
    g(GHOSTTY_RENDER_STATE_IMAGE_DATA_SOURCE_WIDTH, &sw); g(GHOSTTY_RENDER_STATE_IMAGE_DATA_SOURCE_HEIGHT, &sh);
    double item[14] = {(double)id, (double)ig, (double)layer, (double)z, (double)col, (double)row, (double)ox, (double)oy, (double)pw, (double)ph, (double)sx, (double)sy, (double)sw, (double)sh};
    v.insert(v.end(), item, item + 14);
  }
  napi_value ab, fa, o, gv;
  void* data;
  NAPI_CHECK(napi_create_arraybuffer(env, v.size() * sizeof(double), &data, &ab));
  if (!v.empty()) memcpy(data, v.data(), v.size() * sizeof(double));
  NAPI_CHECK(napi_create_typedarray(env, napi_float64_array, v.size(), ab, 0, &fa));
  NAPI_CHECK(napi_create_object(env, &o));
  napi_create_double(env, (double)gen, &gv);
  napi_set_named_property(env, o, "gen", gv); napi_set_named_property(env, o, "list", fa);
  return o;
}

// imageData(handle, imageId) -> { w, h, rgba: Buffer } | null   (all formats converted to RGBA8; max 64 MB)
static napi_value ImageData(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  uint32_t id; NAPI_CHECK(napi_get_value_uint32(env, argv[1], &id));
  napi_value out; napi_get_null(env, &out);
  std::lock_guard<std::mutex> lk(term->mu);
  GhosttyKittyGraphics kg = nullptr;
  if (ghostty_terminal_get(term->t, GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS, &kg) != GHOSTTY_SUCCESS || !kg) return out;
  GhosttyKittyGraphicsImage im = ghostty_kitty_graphics_image(kg, id);
  if (!im) return out;
  uint32_t w = 0, h = 0; GhosttyKittyImageFormat fmt = GHOSTTY_KITTY_IMAGE_FORMAT_RGBA; GhosttyString px = {};
  ghostty_kitty_graphics_image_get(im, GHOSTTY_KITTY_GRAPHICS_IMAGE_DATA_WIDTH, &w);
  ghostty_kitty_graphics_image_get(im, GHOSTTY_KITTY_GRAPHICS_IMAGE_DATA_HEIGHT, &h);
  ghostty_kitty_graphics_image_get(im, GHOSTTY_KITTY_GRAPHICS_IMAGE_DATA_FORMAT, &fmt);
  if (ghostty_kitty_graphics_image_get(im, GHOSTTY_KITTY_GRAPHICS_IMAGE_DATA_PIXELS, &px) != GHOSTTY_SUCCESS) return out;
  size_t n = (size_t)w * h;
  if (!w || !h || n * 4 > (64u << 20)) return out;
  size_t bpp = fmt == GHOSTTY_KITTY_IMAGE_FORMAT_RGB ? 3 : fmt == GHOSTTY_KITTY_IMAGE_FORMAT_GRAY_ALPHA ? 2 : fmt == GHOSTTY_KITTY_IMAGE_FORMAT_GRAY ? 1 : 4;
  if (px.len < n * bpp) return out;
  napi_value buf; uint8_t* d;
  NAPI_CHECK(napi_create_buffer(env, n * 4, (void**)&d, &buf));
  const uint8_t* s = px.ptr;
  for (size_t i = 0; i < n; i++, d += 4, s += bpp) {
    switch (bpp) {
      case 4: d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = s[3]; break;
      case 3: d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = 255; break;
      case 2: d[0] = d[1] = d[2] = s[0]; d[3] = s[1]; break;
      default: d[0] = d[1] = d[2] = s[0]; d[3] = 255;
    }
  }
  napi_value o, v;
  NAPI_CHECK(napi_create_object(env, &o));
  napi_create_uint32(env, w, &v); napi_set_named_property(env, o, "w", v);
  napi_create_uint32(env, h, &v); napi_set_named_property(env, o, "h", v);
  napi_set_named_property(env, o, "rgba", buf);
  return o;
}

// stats(handle) -> instrumentation counters
static napi_value Stats(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  Term* term = unwrap(env, argv[0]); if (!term) return nullptr;
  napi_value o, v;
  NAPI_CHECK(napi_create_object(env, &o));
  auto set = [&](const char* k, double d) { napi_create_double(env, d, &v); napi_set_named_property(env, o, k, v); };
  set("parseMs", term->parseNs.load() / 1e6); set("readerWaitMs", term->readWaitNs.load() / 1e6);
  set("reads", (double)term->reads.load()); set("bytes", (double)term->bytes.load()); set("handoffs", (double)term->handoffs.load());
  return o;
}

// close(handle)
static napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  NAPI_CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  void* p = nullptr;
  if (napi_get_value_external(env, argv[0], &p) == napi_ok && p) term_close(static_cast<Term*>(p));
  return nullptr;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor d[] = {
    {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"spawn", nullptr, Spawn, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"input", nullptr, Input, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"resize", nullptr, Resize, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"scroll", nullptr, Scroll, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"snapshot", nullptr, Snapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"memory", nullptr, Memory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"compress", nullptr, Compress, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"key", nullptr, Key, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"mouse", nullptr, Mouse, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"select", nullptr, Select, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"selectionText", nullptr, SelectionText, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setTheme", nullptr, SetTheme, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"paste", nullptr, Paste, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setClipboardPolicy", nullptr, SetClipboardPolicy, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"hyperlinkAt", nullptr, HyperlinkAt, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"images", nullptr, Images, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"imageData", nullptr, ImageData, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stats", nullptr, Stats, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(d) / sizeof(d[0]), d);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
