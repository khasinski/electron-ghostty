// Types for window.ghostty (dist/electron-ghostty.js). Only the xterm.js-style APIs that are implemented are declared;
// everything else throws "not implemented" at runtime (see README).
export interface IDisposable { dispose(): void }
export type IEvent<T> = (listener: (e: T) => void) => IDisposable;

export interface ITheme {
  foreground?: string; background?: string; cursor?: string;
  black?: string; red?: string; green?: string; yellow?: string; blue?: string; magenta?: string; cyan?: string; white?: string;
  brightBlack?: string; brightRed?: string; brightGreen?: string; brightYellow?: string; brightBlue?: string;
  brightMagenta?: string; brightCyan?: string; brightWhite?: string;
}

export interface ITerminalOptions {
  /** 'external': you feed bytes with write() (xterm.js style). 'pty': the host process runs the shell configured in attach(). */
  mode?: 'external' | 'pty';
  cols?: number; rows?: number;
  fontSize?: number; fontFamily?: string;
  theme?: ITheme;
  /** Scrollback lines. */
  scrollback?: number;
  [option: string]: unknown;
}

export interface IBufferLine {
  readonly length: number;
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}
export interface IBuffer {
  readonly cursorX: number; readonly cursorY: number;
  readonly viewportY: number; readonly baseY: number; readonly length: number;
  /** Only rows inside the viewport are available; others return undefined. */
  getLine(y: number): IBufferLine | undefined;
}

export class Terminal implements IDisposable {
  constructor(options?: ITerminalOptions);
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly options: ITerminalOptions;
  readonly buffer: { readonly active: IBuffer };
  open(parent: HTMLElement): void;
  dispose(): void;
  resize(cols: number, rows: number): void;
  focus(): void; blur(): void; refresh(start?: number, end?: number): void; clearTextureAtlas(): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  writeln(data: string | Uint8Array, callback?: () => void): void;
  paste(data: string): void;
  input(data: string): void;
  clear(): void; reset(): void;
  scrollLines(amount: number): void; scrollPages(amount: number): void;
  scrollToTop(): void; scrollToBottom(): void; scrollToLine(line: number): void;
  hasSelection(): boolean;
  /** Text cached when the selection changes, capped at 1 MiB. */
  getSelection(): string;
  selectAll(): void; clearSelection(): void;
  /** Visible rows only. */
  select(column: number, row: number, length: number): void;
  selectLines(start: number, end: number): void;
  loadAddon(addon: { activate(terminal: Terminal): void; dispose(): void }): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  onData: IEvent<string>;
  onBell: IEvent<void>;
  onTitleChange: IEvent<string>;
  onResize: IEvent<{ cols: number; rows: number }>;
  onSelectionChange: IEvent<void>;
  onScroll: IEvent<number>;
  onCursorMove: IEvent<void>;
  onRender: IEvent<{ start: number; end: number }>;
  /** `key` is the DOM key, not the escape sequence xterm.js reports. */
  onKey: IEvent<{ key: string; domEvent: KeyboardEvent }>;
  /** Not in xterm.js: the child process exited (mode 'pty'). */
  onExit: IEvent<number>;
}

export class FitAddon {
  activate(terminal: Terminal): void; dispose(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
  fit(): void;
}
/** No-ops: rendering is always GPU. Exist so code written for xterm.js keeps loading. */
export class WebglAddon { activate(terminal: Terminal): void; dispose(): void; onContextLoss: IEvent<void> }
export class CanvasAddon extends WebglAddon {}
/** Throw 'not implemented' on activate(). */
export class SearchAddon { activate(terminal: Terminal): void; dispose(): void }
export class SerializeAddon { activate(terminal: Terminal): void; dispose(): void }
export class WebLinksAddon { activate(terminal: Terminal): void; dispose(): void }

declare global {
  interface Window {
    ghostty: { Terminal: typeof Terminal; FitAddon: typeof FitAddon; WebglAddon: typeof WebglAddon; CanvasAddon: typeof CanvasAddon;
      SearchAddon: typeof SearchAddon; SerializeAddon: typeof SerializeAddon; WebLinksAddon: typeof WebLinksAddon };
  }
}
