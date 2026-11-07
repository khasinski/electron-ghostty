# electron-ghostty

Szybki terminal do aplikacji Electron, zbudowany na **libghostty-vt** (rdzeń terminala z Ghostty).
Rdzeń (PTY + parser VT + scrollback) działa natywnie w osobnym procesie, a renderer rysuje siatkę
jednym wywołaniem WebGL2 na klatkę.

Status: wczesna wersja (0.1.0), macOS arm64 i Linux. Zobacz `PLAN.md` i `bench/RESULTS.md`.

## Wyniki (vs xterm.js 6.0 + WebGL, ta sama powłoka Electron, mediana z 5 przebiegów)

| | xterm.js | electron-ghostty |
|---|---|---|
| `cat` 36 MB przez PTY | 41,7 MB/s | 191 MB/s (4,6x; sufit PTY macOS ~170-200 MB/s) |
| przyrost pamięci po flood (100k linii) | 340 MB | 16 MB (21x mniej) |
| opóźnienie klawisz → koniec `draw()` | 0,6 ms | 0,3 ms |
| pamięć w bezczynności (całe drzewo procesów) | 160 MB | 173 MB (stały koszt Chromium dominuje) |

Metodyka, ograniczenia i pełne dane: `bench/RESULTS.md`. Wyniki zależą od obciążenia maszyny: pod silnym obciążeniem
ten sam test dawał 3,0x i +27 MB (patrz RESULTS).

## Instalacja

```sh
npm install electron-ghostty
```

Paczka zawiera gotowe binaria (prebuilds, N-API) dla: **macOS arm64, Linux x64, Linux arm64** (Linux: glibc >= 2.35).
Nie trzeba kompilatora ani `zig`. Windows i macOS x64 nie są wspierane. Testowane tylko z Electronem 45 (`peerDependencies`:
`electron >= 45`). Brak binarki dla Twojej platformy kończy się czytelnym błędem z listą wspieranych platform.

Aplikacja pakowana do asar musi odpakować natywne pliki, np. w electron-builder:
`"asarUnpack": ["**/node_modules/electron-ghostty/prebuilds/**"]` (zweryfikowane z `@electron/asar --unpack "*.node"`).

Strona używa jednego pliku: `<script src="node_modules/electron-ghostty/dist/electron-ghostty.js">` (albo
`import 'electron-ghostty/renderer'` w bundlerze), który ustawia `window.ghostty`; typy: `electron-ghostty/renderer`.

## Użycie

```js
// proces główny
const { app, BrowserWindow } = require('electron');
const { attach, preloadPath, assetPath } = require('electron-ghostty');

app.whenReady().then(() => {
  const win = new BrowserWindow({ webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true } });
  attach(win, { shell: '/bin/zsh', scrollbackLines: 100000 });
  win.loadFile('index.html');
});
```

Strona musi zawierać `<canvas id="c">`, `<textarea id="ime">` oraz skrypty `keymap.js` i `renderer.js`
(zobacz `app/index.html`) albo użyć API w stylu xterm.js opisanego niżej (`app/xterm-demo.html`).
Renderer obsługuje wiele paneli na jednym kontekście WebGL2 (Cmd+D dzieli, Cmd+W zamyka, Cmd+[ / ] przełącza fokus).

## API w stylu xterm.js (`app/terminal.js`)

Strona ładuje `keymap.js`, `renderer.js`, `terminal.js` (ścieżki: `assetPath(...)`) i dostaje `window.ghostty`:

```js
const { Terminal, FitAddon, WebglAddon } = window.ghostty;
const term = new Terminal({ mode: 'external' });   // jak xterm.js: aplikacja ma własny PTY i woła write()
term.loadAddon(new FitAddon());
term.open(document.getElementById('t'));
ptyProcess.onData((d) => term.write(d));            // np. node-pty w procesie głównym, przez IPC
term.onData((d) => ptyProcess.write(d));            // klawisze zakodowane przez libghostty
term.onResize(({ cols, rows }) => ptyProcess.resize(cols, rows));
```

`mode: 'pty'` (domyślny w demo bez `write`) uruchamia powłokę w procesie hosta: bajty nigdy nie trafiają do JS
(to daje pełną przepustowość PTY). Polecenie do uruchomienia ustawia tylko proces główny (`attach(win, { shell })`),
strona nie może wybrać, co wykonać.

Zasada: zaimplementowane jest tylko to, co nie psuje modelu wydajności (bajty i scrollback zostają w natywnym hoście,
strona trzyma tylko widoczne wiersze). Reszta rzuca `Error('... is not implemented (powód)')`.

| Zaimplementowane | Uwagi |
|---|---|
| `new Terminal(opts)`: `cols`, `rows`, `fontSize`, `fontFamily`, `theme` (kolory `#rgb`/`#rrggbb`), `scrollback`, `mode` | bez `cols`/`rows` terminal dopasowuje się do kontenera |
| `open`, `dispose`, `resize`, `focus`, `blur`, `refresh` (no-op), `clearTextureAtlas` | |
| `write(data, cb)`, `writeln`, `paste`, `input`, `clear`, `reset` | `cb` po sparsowaniu przez hosta; zapisy w jednym mikrozadaniu są sklejane |
| `onData`, `onBell`, `onTitleChange`, `onResize`, `onSelectionChange`, `onScroll`, `onCursorMove`, `onRender`, `onKey`, `onExit` (nasze) | `onKey.key` to klawisz DOM, nie sekwencja |
| `scrollLines/Pages/ToTop/ToBottom/ToLine` | |
| `hasSelection`, `getSelection` (synchroniczne, z cache do 1 MiB), `selectAll`, `select`, `selectLines`, `clearSelection` | `select`/`selectLines` tylko dla widocznych wierszy |
| `buffer.active`: `cursorX/Y`, `viewportY`, `baseY`, `length`, `getLine(y).translateToString()` | tylko widoczne wiersze, poza widokiem `getLine` zwraca `undefined` |
| `options` w locie: `fontSize`, `fontFamily`, `theme`; `attachCustomKeyEventHandler` (tylko keydown); `loadAddon`; `FitAddon` | pozostałe opcje są ignorowane z jednorazowym ostrzeżeniem |
| `WebglAddon`, `CanvasAddon` | no-op: renderer jest zawsze GPU |

| Not implemented | Powód |
|---|---|
| `parser.*`, `registerCsi/Dcs/Esc/OscHandler` | parser działa w innym wątku/procesie i nie może synchronicznie wołać JS |
| `buffer.normal/alternate`, `buffer.active.type`, `IBufferLine.getCell`, dostęp do wierszy poza widokiem | scrollback jest w hoście; kopia w stronie zużyłaby pamięć, którą ta biblioteka oszczędza |
| `registerMarker`, `registerDecoration`, `markers` | j.w. |
| `registerLinkProvider`, `WebLinksAddon` | hiperłącza OSC 8 działają natywnie (Cmd+klik); dopasowanie URL w tekście wymaga scrollbacku |
| `SearchAddon`, `SerializeAddon` | wymagają dostępu do całego bufora |
| `unicode`, `modes`, `onBinary`, `onLineFeed`, `onWriteParsed`, `registerCharacterJoiner`, `attachCustomWheelEventHandler` | brak odpowiednika lub brak powodu, by mirrorować stan do strony |

Pomiar ścieżki `write()` (bez PTY, ten sam korpus 36 MB, porcje 64 KB, 5 przebiegów w przeplocie, `bench/write-path/run.sh`):
xterm.js 0,57 s (64 MB/s), electron-ghostty 0,09 s (400 MB/s), czyli ok. 6x; pamięć przypisana terminalowi 285 vs 56 MB (5x mniej).

## Budowanie

Wymagania: macOS, Node, Xcode CLT, `zig` 0.17.x (`mise.toml`), submoduł `vendor/ghostty` na commicie
z `vendor/PINNED_COMMIT` (C API libghostty-vt jeszcze się zmienia).

```sh
git clone https://github.com/ghostty-org/ghostty vendor/ghostty && git -C vendor/ghostty checkout $(cat vendor/PINNED_COMMIT)
npm install
npm run build:native      # libghostty-vt + addon N-API
npm start                 # aplikacja demo (electron app/main.js)
npm test                  # testy natywne
npm run test:app          # test z prawdziwymi zdarzeniami wejścia (okno ukryte)
bench/e2e/run.sh 5        # porównanie z xterm.js (potrzebuje: npm i -D @xterm/xterm @xterm/addon-webgl node-pty; make-corpus)
```

## Co działa
PTY, kolory 16/256/24-bit, atrybuty (bold, italic, faint, inverse, underline x5, strike, overline), znaki szerokie,
kursor (4 style), klawiatura przez encoder libghostty (kitty keyboard, DECCKM), IME (przez ukryty `textarea`),
mysz (raportowanie dla aplikacji TUI, zaznaczanie: przeciąganie, słowo, linia), Cmd+C / Cmd+A / Cmd+V,
bezpieczne wklejanie (bracketed paste, odrzucanie niebezpiecznego tekstu), scrollback z kompresją w bezczynności,
motyw Catppuccin Mocha, resize, wiele paneli na jednym kontekście GL, kolorowe emoji (osobny atlas RGBA
alokowany dopiero przy pierwszym emoji), hiperłącza OSC 8 (Cmd+klik, tylko http(s)/mailto), OSC 52 (domyślnie
odrzucane; `osc52: 'allow'` w `attach`), grafika kitty (obrazy RGB/RGBA/PNG, tekstury WebGL, limit 64 MB na terminal;
ograniczenie: warstwy poniżej tekstu/tła rysowane są nad tekstem).

## Czego nie ma (świadomie lub jeszcze)
- Ligatury.
- WebGPU i natywna rasteryzacja glifów: nie zrobione; decyzja w `PLAN.md` (rendering nie jest wąskim gardłem, patrz pomiary).
- Linux: zweryfikowany w Dockerze arm64 (Electron 45 pod xvfb, WebGL przez SwiftShader): pełny `test/app-input.js` przechodzi (`scripts/test-linux-docker.sh`, uruchamiany: `docker run --rm -v $PWD:/src:ro -v $PWD/scripts:/s:ro node:22-bookworm bash /s/test-linux-docker.sh`). Nie testowano na realnym GPU ani x64.
- Windows: brak ConPTY, nie działa.
- Prebuildy: budowane i weryfikowane w CI (macOS arm64, Linux x64/arm64; instalacja tarballa bez kompilatora), publikacja na npm dopiero po utworzeniu tagu `v*` i ustawieniu `NPM_TOKEN`. macOS x64 i Windows: brak.
- `MessagePortMain` kopiuje bufory klatek (kilka KB na klatkę).
