import "./BottomBar.css";

// The decorative frame at the bottom edge of the screen (the band of the frame continuing from the left pane). It shows no information
// (credits moved to the Accounts section of the left pane; see AccountsPanel.tsx).
export function BottomBar() {
  return <footer className="bottom-bar" aria-hidden="true" />;
}
