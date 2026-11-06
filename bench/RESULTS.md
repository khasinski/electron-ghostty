# Wyniki: bramka 1 (silnik VT bez renderowania)

Środowisko: macOS (arm64), Node 26.10, `@xterm/headless` 6.0.0 vs libghostty-vt
(commit `8b3b025`, ReleaseFast) przez addon N-API. Terminal 200x50. Pamięć mierzona
`footprint` (phys_footprint, uwzględnia skompresowane strony), każdy scenariusz w świeżym procesie,
payload budowany przed pomiarem bazowym.

Odtworzenie: `npm run bench:xterm`, `npm run bench:ghostty` (`CORPUS=real` dla tekstu realnego).

## Przepustowość (jeden wątek, chunki 64 KB)

| Ładunek | xterm.js | libghostty-vt | stosunek |
|---|---|---|---|
| plain ASCII | 38 MB/s | 2277 MB/s | 60x |
| kolor (SGR 256 co 16 znaków) | 37 MB/s | 406 MB/s | 11x |
| realny tekst, 1M linii, bez kompresji w trakcie | – | 301 MB/s | ~8x |
| realny tekst, 1M linii, z kompresją w trakcie | – | 60–77 MB/s | ~2x |

Koszt kompresji w trakcie floodu to głównie sama kompresja (~78 µs/stronę ≈ 330 ms na 4212 stron),
więc ograniczenie nie zależy od progu. Wniosek: kompresować w bezczynności, nie w locie.

## Pamięć (footprint)

Realny tekst (źródła z drzewa ghostty, krótkie linie, jak w typowym użyciu):

| Scrollback | xterm.js | libghostty gorący | libghostty po kompresji |
|---|---|---|---|
| 10k linii | 38 MB | 17 MB | ~0–1 MB |
| 100k linii | 344 MB | 167 MB | ~7 MB (49x mniej) |
| 1M linii | 3090 MB | 1648 MB | ~61 MB (50x mniej) |

Losowy kolorowy tekst, pełne 200 kolumn (najgorszy przypadek, słabo się kompresuje):

| Scrollback | xterm.js | libghostty gorący | libghostty po kompresji |
|---|---|---|---|
| 100k linii | 278 MB | 186 MB | 97 MB (2,9x mniej) |
| 1M linii | 3117 MB | 1704 MB | 892 MB (3,5x mniej) |

## Szczyt pamięci podczas floodu (1M linii realnego tekstu)

| Polityka | Szczyt | Przepustowość |
|---|---|---|
| bez kompresji w trakcie | 1636 MB | 301 MB/s |
| kompresja gdy >1024 gorących stron | 418 MB | 60 MB/s |
| >256 | 127 MB | 64 MB/s |
| >64 | 78 MB | 77 MB/s |
| >4 | 61 MB | 29 MB/s |

Inkrementalny kompresor przy każdym przebiegu skanuje całą skompresowaną historię (~44 ms przy 4k stron),
więc częste przebiegi są drogie.

## Ocena bramek

| Bramka | Wynik |
|---|---|
| Przepustowość >= 5x | PRZESZŁA (11x–60x bez kompresji w locie; ~2x z kompresją w locie) |
| Pamięć 100k linii <= 1/4 | PRZESZŁA dla realnego tekstu po kompresji (1/49); NIE przeszła dla losowych pełnych linii (1/2,9) i dla gorącego bufora (0,48x) |

## Decyzje wynikające z pomiarów
1. Polityka: bez kompresji podczas floodu poniżej progu (domyślnie ~256 gorących stron), kompresja
   w bezczynności (token `ghostty_terminal_compression_activity`), twardy próg wymusza synchroniczny przebieg.
2. Ukryte terminale kompresujemy natychmiast (`FULL`).
3. Domyślny limit scrollbacku w bajtach, nie w liniach.
4. Do zgłoszenia upstream / zbadania: koszt przebiegu inkrementalnego rośnie z liczbą skompresowanych stron.

## Ograniczenia pomiaru
- To silnik bez renderera i bez PTY. Pamięć i opóźnienie renderera Electrona (GPU, atlas) są jeszcze niezmierzone.
- Węzeł Node z xterm headless nie zawiera DOM ani canvasa, więc baseline xterm.js w przeglądarce będzie wyższy.

# Wyniki: bramka 2 (aplikacja Electron end-to-end)

Ta sama powłoka Electron, to samo okno 1000x640, 100k linii scrollbacku, `cat` 36,3 MB realnego tekstu
(1M linii) przez prawdziwy PTY. Okno ukryte (`show:false`), throttling wyłączony. 5 par uruchomień
w przeplocie (`bench/e2e/run.sh 5`), maszyna współdzielona z innymi obciążeniami, więc liczy się mediana.
- xterm.js 6.0.0 + addon WebGL, PTY z `node-pty` w procesie głównym, dane przez IPC.
- electron-ghostty: libghostty-vt w utility process, WebGL2, dirty rows przez MessagePort.

| Metryka (mediana z 5) | xterm.js | electron-ghostty | stosunek |
|---|---|---|---|
| czas `cat` 36 MB | 1,02 s | 0,22 s | 4,6x szybciej |
| przepustowość | 35,7 MB/s | 162 MB/s | 4,5x |
| pamięć idle (całe drzewo procesów) | 162 MB | 172 MB | +10 MB (nasz utility process) |
| pamięć po flood + ustabilizowaniu | 506 MB | 190 MB | 2,7x mniej |
| przyrost pamięci po flood (settled - idle) | 344 MB | 18 MB | 19x mniej |

Surowy sufit PTY na tym Macu to ~170 MB/s (czysty czytnik bez parsowania), więc 162 MB/s to praktycznie sufit.
Na tym obciążeniu maksymalne teoretyczne przyspieszenie względem xterm.js wynosi ~4,8x.

## Ocena bramki 2
| Bramka | Wynik |
|---|---|
| Przepustowość >= 5x | PRAWIE (4,5x; sufit PTY ~4,8x) |
| Pamięć 100k linii <= 1/4 | PRZESZŁA dla przyrostu (1/19); całościowo 1/2,7, bo ~165 MB to stały koszt Chromium/GPU |
| Pamięć idle <= 1/2 | NIE przeszła (+6%): stały koszt procesu Electrona dominuje |

## Co dało największy zysk przepustowości (0,40 s -> 0,22 s)
Instrumentacja pokazała: parsowanie to tylko ~105 ms, a PTY oddaje ~1 KB na `read`. Rozwiązanie:
osobne wątki czytnika i parsera, nieblokujący `read` w pętli, adaptacyjna koalescencja (flood: ~0,5 ms
danych na porcję, pisanie: natychmiast, bez opóźnienia). `nanosleep` w oknie koalescencji zabił wydajność
(15 MB/s): na macOS śpi >> 50 us, dlatego `sched_yield`.

## Pułapki zmierzone po drodze
- Okno przykryte/ukryte: Chromium wstrzymuje rAF, a protokół "want po narysowaniu" zatrzymuje strumień.
  To dobre zachowanie produktowe, ale w benchmarku trzeba wyłączyć throttling.
- RSS jest mylący na macOS (kompresja stron): używać `footprint`.
- `MessagePortMain` nie transferuje ArrayBuffer (tylko porty), bufory klatek są kopiowane (kilka KB).

## Aktualizacja: po dodaniu wejścia, myszy, selekcji, motywu i IME

Dwa pełne przebiegi A/B (5 par, przeplot) w różnych warunkach obciążenia maszyny współdzielonej:

| Warunki | xterm.js (MB/s) | electron-ghostty (MB/s) | stosunek | pamięć po floodzie |
|---|---|---|---|---|
| mniejsze obciążenie (przebieg przed zmianami wejścia) | 35,7 | 162,3 | 4,5x | 506 vs 190 MB |
| silne obciążenie (load avg ~20, emulator Androida na ~1100% CPU) | 14,6 | 45,2 | 3,1x | 481 vs 202 MB |

Pod silnym obciążeniem sam addon (bez Electrona) spada z ~187 do ~61 MB/s, więc spadek nie pochodzi z kodu
aplikacji. Stosunek jest jednak niższy (3,1x vs 4,5x): wątek czytnika kosztuje więcej, gdy rdzenie są zajęte
(oczekiwanie w `sched_yield` konkuruje o CPU). Uczciwa deklaracja: 3-4,5x przepustowości zależnie od obciążenia;
przyrost pamięci po floodzie 17-19x mniejszy niezależnie od obciążenia.

## Opóźnienie klawisz -> koniec draw() (40 prób, 3 przebiegi na silnik, mediana)

| | xterm.js | electron-ghostty |
|---|---|---|
| mediana | 0,6 ms | 0,3 ms |
| p95 | 0,7-1,0 ms | 0,5-0,6 ms |

Metoda: od wysłania znaku (nasz: zdarzenie klawisza przez encoder -> PTY -> echo -> klatka; xterm: zapis do PTY)
do końca `draw()` / `onRender` zawierającego znak. NIE obejmuje czasu GPU, kompozytora ani wyświetlacza
(ani `gl.finish`, którego xterm w swoim pomiarze nie ma), więc to nie jest pełne "photon latency".
Rozbicie naszej ścieżki: ok. 0,3 ms pętla klawisz->PTY->parser->klatka, reszta to praca renderera.

Dwa błędy znalezione dzięki pomiarowi: (1) czekanie na `requestAnimationFrame` w trybie bezczynności dodawało
~3 ms; teraz rysujemy od razu, gdy ostatnia klatka była >14 ms temu (flood nadal pacingowany przez rAF);
(2) po przewinięciu historii wpisanie znaku nie wracało na dół (libghostty zostawia to osadzającemu).

## Aktualizacja: po refaktorze na wiele paneli + kolorowe emoji (2026-11-06)
5 par A/B, maszyna współdzielona i obciążona (jak w przebiegu "silne obciążenie"):

| | xterm.js | electron-ghostty | stosunek |
|---|---|---|---|
| przepustowość (mediana) | 15,0 MB/s | 45,0 MB/s | 3,0x |
| pamięć po floodzie | 501 MB | 202 MB | 2,5x mniej |
| przyrost po floodzie (settled - idle) | 339 MB | 27 MB | 12x mniej |

Wynik zgodny z poprzednim przebiegiem pod obciążeniem (45,2 MB/s, 3,1x), więc brak widocznej regresji; wariancja
duża (jeden przebieg ghostty 125 MB/s, reszta ~40-46). Przyrost pamięci 27 MB vs 18 MB wcześniej: nie rozstrzygnięto,
czy to szum pomiaru, czy koszt (np. atlas, bufory paneli); wymaga powtórzenia na spokojnej maszynie.
