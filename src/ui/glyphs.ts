// `view.icons`: Nerd Font icons and symbols some fonts lack. Off, the view uses plain labels and glyphs
// every monospace font has. Set once per session from the configuration.
let enabled = true;
export function setIcons(on: boolean): void { enabled = on; }
export function iconsEnabled(): boolean { return enabled; }
