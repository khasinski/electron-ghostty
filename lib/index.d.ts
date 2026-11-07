import type { BrowserWindow, UtilityProcess } from 'electron';

export interface AttachOptions {
  /** Shell to run in `pty` mode. Default: $SHELL or /bin/zsh. Only the main process can choose what to execute. */
  shell?: string;
  /** Arguments for the shell. Default: ['-l']. */
  args?: string[];
  /** Working directory. Default: $HOME. */
  cwd?: string;
  /** Scrollback limit in lines (default 100000). */
  scrollbackLines?: number;
  /** Scrollback limit in bytes (default unlimited, bounded by lines). */
  scrollbackBytes?: number;
  /** OSC 52 clipboard writes from programs in the terminal: denied unless 'allow'. */
  osc52?: 'deny' | 'allow';
  /** Default colors (0xRRGGBB) and 16 ANSI colors. */
  theme?: { fg?: number; bg?: number; cursor?: number };
}

export interface Attached {
  /** Stop the terminal host process. Also happens when the window closes. */
  kill(): void;
  host: UtilityProcess;
}

/** Start the terminal host process and hand the page a MessagePort. Call before loadFile/loadURL. */
export function attach(win: BrowserWindow, opts?: AttachOptions): Attached;
/** Preload script that forwards the MessagePort into the page (works with sandbox + contextIsolation). */
export const preloadPath: string;
/** Absolute path of a file in app/: 'renderer.js', 'keymap.js', 'terminal.js', 'index.html'. */
export function assetPath(name: string): string;
