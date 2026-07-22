export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.trunc(totalSeconds));
  const minutes = Math.round(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}
