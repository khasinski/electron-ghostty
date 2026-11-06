# electron-ghostty

Szybki terminal do aplikacji Electron, zbudowany na **libghostty-vt** (rdzeń terminala z Ghostty).
Rdzeń (PTY + parser VT + scrollback) działa natywnie w osobnym procesie, a renderer rysuje siatkę
jednym wywołaniem WebGL2 na klatkę.

Status: działający prototyp (macOS arm64). Zobacz `PLAN.md` i `bench/RESULTS.md`.

## Wyniki (vs xterm.js 6.0 + WebGL, ta sama powłoka Electron, mediana z 5 przebiegów)

| | xterm.js | electron-ghostty |
|---|---|---|
| `cat` 36 MB przez PTY | 36 MB/s | 162 MB/s (≈ sufit PTY macOS, ~170 MB/s) |
| przyrost pamięci po flood (100k linii) | 344 MB | 18 MB |
| opóźnienie klawisz → koniec `draw()` | 0,6 ms | 0,3 ms |
| pamięć w bezczynności (całe drzewo procesów) | 162 MB | 172 MB (stały koszt Chromium dominuje) |

Metodyka, ograniczenia i pełne dane: `bench/RESULTS.md`.

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
(zobacz `app/index.html`; pliki wskazuje `assetPath('keymap.js')`, `assetPath('renderer.js')`).
Renderer obsługuje wiele paneli na jednym kontekście WebGL2 (Cmd+D dzieli, Cmd+W zamyka, Cmd+[ / ] przełącza fokus).

## Budowanie

Wymagania: macOS, Node, Xcode CLT, `zig` 0.17.x (`mise.toml`), submoduł `vendor/ghostty` na commicie
z `vendor/PINNED_COMMIT` (C API libghostty-vt jeszcze się zmienia).

```sh
git clone https://github.com/ghostty-org/ghostty vendor/ghostty && git -C vendor/ghostty checkout $(cat vendor/PINNED_COMMIT)
npm install
npm run build:native      # libghostty-vt + addon N-API
npm start                 # aplikacja demo
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
- Prebuilds/CI: `.github/workflows/ci.yml` przechodzi na GitHubie dla macOS (`macos-latest`; `macos-14` nie startował), Linux x64 i arm64: build libghostty + addon, `npm test`, artefakt prebuild. Prebuildy nie są publikowane na npm.
- `MessagePortMain` kopiuje bufory klatek (kilka KB na klatkę).
