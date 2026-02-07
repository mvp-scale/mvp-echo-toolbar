/**
 * Compact status dot indicator for the popup status bar
 * Shows ready/recording/processing state
 */
export default function StatusIndicator() {
  // The status is primarily shown via the tray icon.
  // In the popup, we show a simple "Ready" indicator since
  // the popup is only visible when the user clicks the tray.
  return (
    <div className="flex items-center gap-1">
      <div className="w-1.5 h-1.5 rounded-full bg-green-500"></div>
      <span className="text-green-600 font-medium">Ready</span>
    </div>
  );
}
