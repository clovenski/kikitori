interface Props {
  title: string;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDeleteDialog({ title, onConfirm, onCancel }: Props) {
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-label="Delete job">
        <h2>Delete this job?</h2>
        <p>
          <strong>{title}</strong>
        </p>
        <p className="hint">
          Its transcript, translation, summary and the subtitle files saved for it are removed. The original video is not touched. This cannot be undone.
        </p>
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={onConfirm}>
            Delete job
          </button>
        </div>
      </div>
    </div>
  );
}
