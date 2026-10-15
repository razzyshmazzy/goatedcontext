/**
 * Input decoding + the keymap. Both halves are pure: `decodeKey` turns a raw stdin
 * chunk into a semantic `Key`, and `keyToAction` turns a `Key` + current state into an
 * `Action` (or null). No terminal state, so the whole input model is unit-testable.
 *
 * The keymap deliberately does NOT steal ordinary typing while a text input is active
 * (search, or the add-form rule field): there, printable keys — including q/a/d/e — go
 * to the field, never to a global shortcut (spec §8).
 */
import type { Action, AppState } from "./state.ts";

export interface Key {
  name:
    | "up"
    | "down"
    | "left"
    | "right"
    | "enter"
    | "tab"
    | "escape"
    | "backspace"
    | "ctrl-c"
    | "char";
  /** The literal character when `name === "char"`. */
  ch?: string;
}

/**
 * Decode a single raw stdin chunk into a `Key`. Handles the common one-keypress-per-
 * chunk case plus the standard arrow/escape sequences (both `CSI` `ESC [` and the
 * application-cursor `ESC O` forms). Returns null for anything unrecognized.
 */
export function decodeKey(data: string | Buffer): Key | null {
  const s = typeof data === "string" ? data : data.toString("utf8");
  if (s.length === 0) return null;

  if (s === "\x03") return { name: "ctrl-c" };
  if (s === "\r" || s === "\n") return { name: "enter" };
  if (s === "\t") return { name: "tab" };
  if (s === "\x7f" || s === "\b" || s === "\x08") return { name: "backspace" };
  if (s === "\x1b") return { name: "escape" };

  if (s[0] === "\x1b" && (s[1] === "[" || s[1] === "O")) {
    switch (s[2]) {
      case "A":
        return { name: "up" };
      case "B":
        return { name: "down" };
      case "C":
        return { name: "right" };
      case "D":
        return { name: "left" };
      default:
        return null; // other CSI sequences (page/home/etc.) are ignored for now
    }
  }

  // A lone printable character (space through ~, plus any non-control Unicode).
  const c = s[0]!;
  const code = c.codePointAt(0)!;
  if (code >= 0x20 && code !== 0x7f) return { name: "char", ch: c };
  return null;
}

function isChar(key: Key, ch: string): boolean {
  return key.name === "char" && key.ch === ch;
}

/** Map a decoded key to an action, given the current UI mode. Returns null to ignore. */
export function keyToAction(state: AppState, key: Key): Action | null {
  if (key.name === "ctrl-c") return { type: "quit" };

  const modal = state.modal;
  if (modal) {
    if (modal.type === "help") {
      return { type: "back" };
    }
    if (modal.type === "confirm") {
      if (key.name === "enter" || isChar(key, "y") || isChar(key, "Y")) return { type: "confirmForget" };
      if (key.name === "escape" || isChar(key, "n") || isChar(key, "N")) return { type: "back" };
      return null;
    }
    if (modal.type === "actions") {
      if (key.name === "escape" || isChar(key, "q")) return { type: "back" };
      if (key.name === "up" || isChar(key, "k")) return { type: "modalMove", delta: -1 };
      if (key.name === "down" || isChar(key, "j")) return { type: "modalMove", delta: 1 };
      if (key.name === "enter") {
        const item = modal.items[modal.index];
        return item ? { type: "runTransition", transition: item.transition } : null;
      }
      return null;
    }
    // add form
    if (key.name === "escape") return { type: "back" };
    if (key.name === "enter") return { type: "submitAdd" };
    if (key.name === "tab" || key.name === "up" || key.name === "down") return { type: "modalMove", delta: 1 };
    if (modal.field === 1) {
      if (key.name === "left" || key.name === "right" || isChar(key, " ")) return { type: "modalToggleScope" };
      return null;
    }
    // rule text field: do not steal typing
    if (key.name === "backspace") return { type: "modalInput", ch: "\b" };
    if (key.name === "char") return { type: "modalInput", ch: key.ch! };
    return null;
  }

  if (state.search != null) {
    if (key.name === "escape") return { type: "back" };
    if (key.name === "enter") return { type: "inspect" };
    if (key.name === "up") return { type: "navMove", delta: -1 };
    if (key.name === "down") return { type: "navMove", delta: 1 };
    if (key.name === "backspace") return { type: "searchInput", ch: "\b" };
    if (key.name === "char") return { type: "searchInput", ch: key.ch! };
    return null; // tab/left/right ignored while typing a search
  }

  // Normal navigation mode.
  if (isChar(key, "q")) return { type: "quit" };
  if (key.name === "up" || isChar(key, "k")) return { type: "navMove", delta: -1 };
  if (key.name === "down" || isChar(key, "j")) return { type: "navMove", delta: 1 };
  if (key.name === "left" || isChar(key, "h")) return { type: "back" };
  if (key.name === "right" || isChar(key, "l")) return { type: "inspect" };
  if (key.name === "tab") return { type: "focusToggle" };
  if (key.name === "enter") return { type: "inspect" };
  if (key.name === "escape") return { type: "back" };
  if (isChar(key, "a")) return { type: "openAdd" };
  if (isChar(key, "e")) return { type: "openActions" };
  if (isChar(key, "d")) return { type: "openForget" };
  if (isChar(key, "/")) return { type: "searchStart" };
  if (isChar(key, "g")) return { type: "navEdge", edge: "top" };
  if (isChar(key, "G")) return { type: "navEdge", edge: "bottom" };
  if (isChar(key, "r")) return { type: "refresh" };
  if (isChar(key, "?")) return { type: "openHelp" };
  return null;
}
