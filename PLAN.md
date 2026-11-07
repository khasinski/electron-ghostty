# electron-ghostty: plan

Cel: terminal do aplikacji Electron, oparty na libghostty-vt, znacznie szybszy od xterm.js
i zużywający drastycznie mniej pamięci. Wydajność i pamięć są kryteriami akceptacji.

## Stan libghostty (listopad 2026)
- libghostty-vt: parser VT + stan terminala, macOS/Linux/Windows/WASM, tagi `vt-X.Y.Z`.
- Brak renderera w libghostty-vt. Render GPU budujemy sami.
- Sygnatury C API nadal się zmieniają: przypiąć commit, owinąć własnym cienkim C ABI.
- Pełny embedding API (GhosttyKit) jest niestabilny i używany głównie przez aplikację macOS.

## Architektura

```
Renderer (Chromium)                Utility process (jeden, wspólny)
┌──────────────────────┐           ┌─────────────────────────────┐
│ WebGL2 (potem WebGPU)│◄─ port ──│ N-API addon                 │
│ instanced quads +    │  cell     │  ├ libghostty-vt            │
│ glyph atlas (limit)  │  buffer   │  ├ PTY (forkpty / ConPTY)   │
│ input → MessagePort  │── input ─►│  └ render-state diff        │
└──────────────────────┘           └─────────────────────────────┘
```

- PTY i VT poza wątkiem UI. Bajty z PTY nigdy nie trafiają do JS.
- Render state: stały układ komórek, dirty rows, licznik wersji. KOREKTA: SharedArrayBuffer nie przechodzi
  między procesami (utility → renderer), więc domyślnie utility wysyła do renderera tylko brudne wiersze
  przez MessagePort z transferem ArrayBuffer (jedna klatka w locie, backpressure po stronie renderera).
  SAB tylko w trybie 'addon w workerze renderera' (wymaga nodeIntegration, cross-origin isolation).
- Jedna instancjonowana draw-call na klatkę, sprzężona z vsync, z koalescencją
  i limitem bajtów na klatkę podczas floodu.
- Wejście (klawiatura, mysz) idzie bezpośrednio do utility process, z pominięciem main.

### Pamięć
1. Scrollback tylko natywnie (strony libghostty, deduplikowane style, limit w bajtach).
   Renderer trzyma tylko viewport i pobiera wiersze przy przewijaniu.
2. Jeden wspólny proces natywny, wątek/worker na terminal.
3. Jeden kontekst GL/WebGPU i jeden atlas na okno (scissor dla paneli).
   Atlas ma twardy limit (np. 2048² R8) z eksmisją LRU; emoji w osobnej teksturze.
4. Spike: natywna rasteryzacja i shaping glifów (CoreText/FreeType/DirectWrite)
   zamiast Canvas 2D + HarfBuzz WASM. Fallback: Canvas 2D.
5. Zero obiektów JS na komórkę, zero DOM, zero stringów z PTY.
6. Lazy loading funkcji opcjonalnych; zwalnianie buforów ukrytych terminali.

Ograniczenie: pamięć procesu GPU Chromium i baseline renderera nie są pod naszą kontrolą.
Mierzymy deltę względem pustego okna Electrona.

## Bramki (do korekty po fazie 0)
| Metryka | Bramka |
|---|---|
| Przepustowość | >= 5x xterm.js |
| Pamięć przy 100k linii scrollbacku | <= 1/4 xterm.js |
| Pamięć idle (delta vs puste okno) | <= 1/2 xterm.js |
| Opóźnienie klawisz→piksel | nie gorsze niż xterm.js, cel: wyraźnie lepsze |

Pamięć mierzona dla całego drzewa procesów (main + renderer + GPU + utility)
metryką `footprint` na macOS, nie samym RSS.
Jeśli bramka 1 nie przejdzie, zatrzymujemy się i zmieniamy podejście.

## Fazy
0. Setup + harness benchmarków z baseline xterm.js (macOS).
1. Addon + libghostty-vt + PTY bez UI, mierzone w Node. **Bramka 1.**
2. Renderer: WebGL2, atlas z limitem, spike natywnej rasteryzacji glifów. **Bramka 2.**
3. Pełna funkcjonalność: selekcja, scrollback, mysz, kitty keyboard, IME, OSC 8/52, kitty graphics.
4. WebGPU, wielopanelowość na jednym kontekście, tuning.
5. Pakowanie npm (prebuilds), Linux i Windows (ConPTY), CI.

Odrzucona alternatywa: natywny NSView + CAMetalLayer z pełnym Ghostty.
Najszybszy, ale tylko macOS i kruchy. Opcjonalny tryb po fazie 4.

## Metryki benchmarków
- Przepustowość: `cat` 100 MB, vtebench, flood z kolorami.
- Opóźnienie klawisz→piksel.
- CPU na idle i w floodzie.
- Pamięć dla scrollbacku 10k / 100k / 1M linii przy 200 kolumnach.

## Otwarte
- Tylko macOS na start (założenie).
- Pakiet npm do osadzania vs jedna aplikacja (założenie: pakiet npm).
- Ligatury i kitty graphics: poza pierwszym wydaniem, chyba że zdecydujesz inaczej.

## Status realizacji (2026-11-06)
- Faza 0 GOTOWA: harness + baseline xterm.js (`bench/`, `bench/RESULTS.md`).
- Faza 1 GOTOWA: addon N-API (libghostty-vt, PTY, wątki czytnik/parser z adaptacyjną koalescencją,
  kompresja scrollbacku w bezczynności, snapshot render state). Bramka 1 przeszła.
- Faza 2 GOTOWA: aplikacja Electron, utility process, renderer WebGL2 (1 draw call, atlas R8 2048^2).
  Bramka 2: przepustowość 3-4,5x (zależnie od obciążenia maszyny; sufit PTY ~4,8x), przyrost pamięci 17-19x mniejszy,
  opóźnienie klawisz->draw 0,3 ms vs 0,6 ms. Pamięć idle bez poprawy (stały koszt Chromium).
- Faza 3 GOTOWA w zakresie: klawiatura przez encoder libghostty (kitty keyboard, DECCKM), IME, mysz (raportowanie
  i zaznaczanie: przeciąganie/słowo/linia), schowek (Cmd+C/A/V), bezpieczne wklejanie (bracketed + odrzucanie),
  motyw Catppuccin, scroll do dołu przy wpisywaniu. Testy: `npm test`, `npm run test:app`.
- Faza 5 CZĘŚCIOWO: API osadzania (`lib/index.js`: attach/preloadPath/assetPath), README, skrypty budowania,
  przypięty commit. Brak prebuilds i CI. Kod PTY ma gałąź pod Linux (NIEPRZETESTOWANA), Windows (ConPTY) brak.
- ŚWIADOMIE POMINIĘTE: OSC 52 i OSC 8 (wymagają UI uprawnień; bez niego bezpieczniej wyłączone), grafika kitty,
  ligatury i kolorowe emoji (atlas R8).
- Do zrobienia: wiele terminali na jednym kontekście GL, WebGPU, natywna rasteryzacja glifów (spike),
  prebuilds + CI, Linux/Windows, redukcja stałego kosztu GPU/renderera, zgłoszenie upstream kosztu
  przebiegu inkrementalnej kompresji.

## Status realizacji, aktualizacja (2026-11-06)
Zrobione i zweryfikowane lokalnie (macOS arm64, okna ukryte): wiele paneli na jednym kontekście GL, OSC 8 (Cmd+klik),
polityka OSC 52 (domyślnie odmowa), kolorowe emoji (leniwy atlas RGBA, zweryfikowane zrzutem ekranu), rdzeń natywny
na Linuksie arm64 w Dockerze.
Nie zrobione, z powodem:
- Grafika kitty, ligatury: poza zakresem prototypu.
- WebGPU: renderowanie to ułamek ms na klatkę, wąskim gardłem jest PTY (~170 MB/s), więc WebGPU nie zmieni wyniku; bez pomiaru nie deklarujemy zysku.
- Natywna rasteryzacja glifów: Canvas2D + atlas kosztuje jednorazowo; nie jest na ścieżce gorącej.
- Windows ConPTY: wymaga maszyny z Windows, niedostępnej tutaj.
- Prebuilds: workflow CI napisany, nieuruchomiony.

### Dane do decyzji o WebGPU / natywnej rasteryzacji (2026-11-06)
Flood 36 MB (`cat`) w aplikacji: 101 klatek w 0,81 s, 413k komórek wgranych, najgorsza klatka po stronie CPU 2,5 ms,
95 slotów atlasu. Renderowanie zajmuje ułamek budżetu, a czas całości wyznacza PTY/parser, więc WebGPU ani natywna
rasteryzacja glifów nie dałyby mierzalnego zysku na tym obciążeniu. Decyzja: nie robić (do ponownej oceny, jeśli
pojawi się obciążenie z bardzo dużą liczbą unikalnych glifów lub wiele dużych paneli). Czas GPU nie był mierzony.

### Linux (2026-11-06)
UI Electrona na Linuksie arm64 zweryfikowane w Dockerze (xvfb + SwiftShader): klawisze, zaznaczanie, kopiowanie, scroll, opóźnienie 0,6 ms mediana, ALL OK. Bez realnego GPU i bez x64.

### Czas GPU (2026-11-06)
`EXT_disjoint_timer_query_webgl2` na rzeczywistym GPU macOS (Apple, ukryte okno), flood 36 MB: 38 próbek,
mediana 0,50 ms, p95 1,15 ms, max 1,32 ms na rysowanie. Razem z 2,5 ms po stronie CPU (najgorsza klatka) daje to
dane, że render nie jest wąskim gardłem: przy 0,5 ms GPU backend WebGPU nie może przyspieszyć floodu, którego czas
wyznacza PTY (~170 MB/s). Decyzja "nie robić WebGPU / natywnej rasteryzacji" opiera się teraz na pomiarze CPU i GPU,
ale pozostaje do akceptacji użytkownika.

### Grafika kitty (2026-11-07)
Zaimplementowana na API render-state libghostty (`images`/`imageData` w addonie, tekstury + quady w rendererze, pikselowy rozmiar komórki przekazywany do `ghostty_terminal_resize`). Test: `test/app-kitty.js` (kolory narożników po skalowaniu 2x2 -> 12x6 komórek). Ograniczenie: obrazy z warstw BELOW_BACKGROUND/BELOW_TEXT są rysowane nad tekstem (jeden przebieg shadera siatki). Niezweryfikowane: animacje, placeholdery Unicode, duże obrazy PNG z prawdziwych narzędzi (`kitty icat`).

### Spike WebGPU (2026-11-07, `bench/webgpu-spike/`)
Ten sam rysunek siatki (117x36 komórek, trójkąt pełnoekranowy, odczyt komórki + atlasu R8, wgranie siatki co klatkę,
okno 2000x1216 px, 300 klatek, ukryte okno, Electron 45, GPU Apple):

| | WebGL2 | WebGPU |
|---|---|---|
| czas GPU (mediana) | 0,188 ms | 0,070 ms |
| czas GPU (p95) | 0,192 ms | 0,176 ms |
| czas CPU wysłania (mediana) | ~0 ms (rozdzielczość 0,1 ms) | ~0 ms |

Oba pomiary GPU używają różnych mechanizmów (EXT_disjoint_timer_query vs timestamp-query), więc różnica ~0,1 ms
jest rzędu niepewności metody. Nawet przyjęta dosłownie, to 0,1 ms z budżetu 16 ms klatki, przy czasie floodu
wyznaczanym przez PTY. Wniosek: przepisanie renderera na WebGPU nie ma uzasadnienia wydajnościowego; spike potwierdza,
że ścieżka istnieje (Electron 45 wystawia WebGPU z timestamp-query), więc można do niej wrócić z powodów funkcjonalnych.

### CI (2026-11-07)
Pierwszy przebieg wykrył błąd (npm install odpalał node-gyp przed zbudowaniem libghostty); naprawiony (`--ignore-scripts` + `build:native`). Po poprawce: ubuntu-24.04 i ubuntu-24.04-arm zielone (build + `npm test` + artefakt). macos-14: job bez runnera, anulowany; do ponowienia.

CI po zmianie na `macos-latest`: macOS, ubuntu-24.04 i ubuntu-24.04-arm zielone (2026-11-07). Poprzednia diagnoza "brak runnera/kolejka" dla macos-14 była niepewna: job kończył się w sekundę, więc raczej odmowa startu niż kolejka.

## Zamknięcie zakresu (2026-11-07, decyzje użytkownika)
- Windows ConPTY: poza zakresem "na chwilę obecną" (decyzja użytkownika).
- Ligatury: odłożone ("zostańmy bez ligatur na razie"); szkic podejścia (serie symboli rasteryzowane jako ciąg na n slotów
  atlasu, opt-in, cache ciągów, pomiar wpływu na flood) jest w historii rozmowy, nic nie zbudowano.
- Natywna rasteryzacja glifów: nie budowana; pomiary (CPU 2,5 ms, GPU mediana 0,5 ms na klatkę przy floodzie) nie pokazują jej na ścieżce gorącej.
Zrealizowane: rdzeń + benchmarki, wejście/mysz/zaznaczenie/IME/schowek, panele, emoji, OSC 8/52, kitty graphics, WebGPU spike, Linux (Docker + CI), CI macOS/Linux.

### API w stylu xterm.js (2026-11-07)
Fasada `app/terminal.js` (README: tabela zaimplementowane / not implemented). Dwa tryby: `pty` (host trzyma PTY, pełna
szybkość) i `external` (aplikacja woła `write()`, jak w xterm.js; 5,7x szybciej i 3,9x mniej pamięci niż xterm.js na
ścieżce write, patrz `bench/RESULTS.md`). Zmiany pod spodem: renderer jako fabryka `createRenderer` (każdy `Terminal` ma
własny canvas/kontekst GL, wspólny port do hosta), tryb bez PTY w addonie (`attach`), zdarzenia bell/title, kompresja
w bezczynności także w trybie `external`. Testy: `test/app-xterm.js`, `test/app-xterm-pty.js`.
