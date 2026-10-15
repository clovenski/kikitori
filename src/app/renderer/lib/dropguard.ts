/**
 * A file dropped outside the dropzone makes Chromium navigate to it, replacing the whole app. Cancel
 * dragover and drop globally; the dropzone still receives its own drop event first.
 */
export function installDropGuard(target: Document): () => void {
  const cancel = (e: Event) => e.preventDefault();
  target.addEventListener('dragover', cancel);
  target.addEventListener('drop', cancel);
  return () => {
    target.removeEventListener('dragover', cancel);
    target.removeEventListener('drop', cancel);
  };
}
