[日本語](desktop-app.ja.md)

# Using the Desktop App

The desktop app opens a ship in a window of its own. The ship's screen is not served on a port, so nothing in a browser can reach it. (The bulletin-board MCP that crew members call still listens on `127.0.0.1`, on a port the OS picks at each start; it needs the secret every session is given.)

## What happens when you open it

- **There is exactly one ship:** it opens at once.
- **There are several ships, or none:** a list appears. Choose a ship and it opens in a window of its own (its own icon in the Dock); the list closes. The **Settings** button on the list opens the settings, where a ship is made.
- **A ship is open:** opening the same ship again brings its window to the front instead of starting a second one.
- **Closing a ship's window stops that ship.** Its crew sessions end with it.
- **Settings:** from the list, or from a ship's window with the menu item (`⌘,` on macOS). In the settings, the Ships tab has an **Open the ship** button instead of start and stop. Removing a ship that is open is refused.
- **The header is the title bar:** the window has no title bar of its own. On macOS the window buttons sit at the left end of the header. On Linux the app draws them at the right end, in the colors of the theme, and a **⋮ button** next to them opens the app's menu (there is no menu bar to click: it holds the menus File (the settings in a ship's window, and quit), Edit, View and Window). Drag the header to move the window.
- **Theme and language:** in the View menu of a ship's window (the theme, the UI language and the crew language) and of the settings window (the theme and the UI language); the list of ships has no View menu of this kind. A choice is applied by the page the same way as its own radio buttons in the left pane's "Settings" section, so it is kept where those are kept (the theme in the window's browser storage, the languages on the ship; the settings window keeps its own language choice). The words of the menu follow the page's language.
- **The window can be narrow:** a ship's window can be made as narrow as a phone (375 px at no zoom on macOS and 463 px on Linux, which keeps room for its window buttons, and wider as the page is zoomed). Below 860 px the left pane becomes a drawer over the conversation, opened with the button at the left of the header, and below 600 px the buttons beside the message box move into a menu ([Screen Layout](../reference/behavior.md#screen-layout)).

Your files are where they always were (`~/.make-it-so`); the desktop app and the browser version read the same ships. **A ship can be open in only one of them at a time**: starting it in one while it runs in the other is refused with a message (close the window, or stop the browser version, first). The settings of either version also count a ship open in the other as running, so it is not started a second time and cannot be removed from there.

## Running it from the source

```
npm run build
npm run start:electron                 # the ship, the list, or the settings, as above
npm run start:electron -- --ship alpha # one ship
npm run start:electron -- --settings   # the settings
```

## Making the app

```
npm run pack   # release/mac-arm64/Make-It-So.app (not packed into an installer); on Linux, release/linux-unpacked/
npm run dist   # release/Make-It-So-<version>-arm64.dmg; on Linux, release/Make-It-So-<version>-x86_64.AppImage
```

The app is **not signed**, so macOS may warn when it is opened from a downloaded file. Signing and notarizing it needs a Developer ID certificate, which is not set up here. Only macOS (Apple silicon) and Linux (x64, as an AppImage) have been built and run so far.

## Releasing

Pushing a tag that matches `version` in `package.json` (for example `v0.1.0`) runs the Release workflow: it checks, builds on macOS (dmg), Windows (NSIS installer) and Linux (AppImage), and attaches all three to a **draft** GitHub release. Read the generated notes, then publish the draft by hand. None of them is signed. The Windows build has not been run on a real machine yet.
