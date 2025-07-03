// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ReactWidget } from '@jupyterlab/apputils';
import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';
import { Time } from '@jupyterlab/coreutils';
import { Signal, ISignal } from '@lumino/signaling';
import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import * as Y from 'yjs';

/**
 * Interface for a history snapshot with user attribution
 */
interface IHistorySnapshot {
  /** Unique identifier for the snapshot */
  id: string;
  /** Timestamp when the snapshot was created */
  timestamp: Date;
  /** User who created this snapshot */
  user: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** Brief description of the changes */
  description: string;
  /** Yjs document state at this snapshot */
  documentState: Uint8Array;
  /** Number of changes since last snapshot */
  changeCount: number;
  /** Cell-level changes summary */
  cellChanges?: Array<{
    cellId: string;
    type: 'added' | 'modified' | 'deleted';
    title: string;
  }>;
}

/**
 * Interface for version restore options
 */
interface IVersionRestoreOptions {
  /** Snapshot ID to restore to */
  snapshotId: string;
  /** Whether to create a new snapshot before restoring */
  createSnapshot?: boolean;
  /** Whether to restore the entire document or only selected cells */
  restoreMode?: 'full' | 'selective';
  /** Cell IDs to restore (only used with selective mode) */
  cellIds?: string[];
}

/**
 * Interface for history service
 */
interface IHistoryService {
  /** Signal emitted when history changes */
  historyChanged: ISignal<IHistoryService, IHistorySnapshot[]>;
  /** Get all history snapshots */
  getSnapshots(): Promise<IHistorySnapshot[]>;
  /** Get a specific snapshot by ID */
  getSnapshot(id: string): Promise<IHistorySnapshot | null>;
  /** Create a new snapshot */
  createSnapshot(description?: string): Promise<IHistorySnapshot>;
  /** Restore to a specific snapshot */
  restoreSnapshot(options: IVersionRestoreOptions): Promise<void>;
  /** Compute diff between two snapshots */
  computeDiff(fromId: string, toId: string): Promise<{
    added: string[];
    modified: string[];
    deleted: string[];
    cellDiffs: Array<{
      cellId: string;
      type: 'added' | 'modified' | 'deleted';
      oldContent?: string;
      newContent?: string;
    }>;
  }>;
  /** Get maximum number of snapshots to keep */
  getMaxSnapshots(): number;
  /** Set maximum number of snapshots to keep */
  setMaxSnapshots(count: number): void;
  /** Check if history tracking is enabled */
  isEnabled(): boolean;
  /** Enable or disable history tracking */
  setEnabled(enabled: boolean): void;
  /** Show history viewer UI */
  showHistory(): Promise<void>;
  /** Dispose of the service */
  dispose(): void;
}

/**
 * Props for the HistoryViewer React component
 */
interface IHistoryViewerProps {
  historyService: IHistoryService;
  tracker: INotebookTracker;
  translator: ITranslator;
  onClose?: () => void;
}

/**
 * Component for displaying individual history snapshots
 */
const HistorySnapshotItem = ({
  snapshot,
  isSelected,
  onSelect,
  onRestore,
  onDiff,
  translator,
}: {
  snapshot: IHistorySnapshot;
  isSelected: boolean;
  onSelect: () => void;
  onRestore: () => void;
  onDiff: () => void;
  translator: ITranslator;
}) => {
  const trans = translator.load('notebook');
  const timeAgo = Time.formatHuman(snapshot.timestamp);
  const formattedTime = snapshot.timestamp.toLocaleString();

  return (
    <div
      className={`jp-HistoryViewer-snapshot ${isSelected ? 'jp-mod-selected' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onSelect();
        }
      }}
    >
      <div className="jp-HistoryViewer-snapshot-header">
        <div className="jp-HistoryViewer-snapshot-user">
          {snapshot.user.avatar && (
            <img
              src={snapshot.user.avatar}
              alt={snapshot.user.name}
              className="jp-HistoryViewer-snapshot-avatar"
            />
          )}
          <span className="jp-HistoryViewer-snapshot-username">
            {snapshot.user.name}
          </span>
        </div>
        <div className="jp-HistoryViewer-snapshot-time">
          <span title={formattedTime}>{timeAgo}</span>
        </div>
      </div>
      <div className="jp-HistoryViewer-snapshot-description">
        {snapshot.description || trans.__('Untitled change')}
      </div>
      <div className="jp-HistoryViewer-snapshot-changes">
        <span className="jp-HistoryViewer-snapshot-changeCount">
          {trans._n('%1 change', '%1 changes', snapshot.changeCount, snapshot.changeCount)}
        </span>
        {snapshot.cellChanges && snapshot.cellChanges.length > 0 && (
          <div className="jp-HistoryViewer-snapshot-cellChanges">
            {snapshot.cellChanges.map((change, index) => (
              <span
                key={index}
                className={`jp-HistoryViewer-cellChange jp-HistoryViewer-cellChange-${change.type}`}
              >
                {change.type === 'added' && '+'}
                {change.type === 'modified' && '~'}
                {change.type === 'deleted' && '-'}
                {change.title}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="jp-HistoryViewer-snapshot-actions">
        <button
          className="jp-HistoryViewer-button jp-HistoryViewer-button-small"
          onClick={(e) => {
            e.stopPropagation();
            onDiff();
          }}
          title={trans.__('Show differences')}
        >
          {trans.__('Diff')}
        </button>
        <button
          className="jp-HistoryViewer-button jp-HistoryViewer-button-small jp-HistoryViewer-button-primary"
          onClick={(e) => {
            e.stopPropagation();
            onRestore();
          }}
          title={trans.__('Restore to this version')}
        >
          {trans.__('Restore')}
        </button>
      </div>
    </div>
  );
};

/**
 * Component for displaying diff information
 */
const HistoryDiffViewer = ({
  fromSnapshot,
  toSnapshot,
  diff,
  onClose,
  translator,
}: {
  fromSnapshot: IHistorySnapshot;
  toSnapshot: IHistorySnapshot;
  diff: {
    added: string[];
    modified: string[];
    deleted: string[];
    cellDiffs: Array<{
      cellId: string;
      type: 'added' | 'modified' | 'deleted';
      oldContent?: string;
      newContent?: string;
    }>;
  };
  onClose: () => void;
  translator: ITranslator;
}) => {
  const trans = translator.load('notebook');

  const formatDiffLines = (oldContent?: string, newContent?: string) => {
    if (!oldContent && !newContent) return [];
    
    const oldLines = oldContent ? oldContent.split('\n') : [];
    const newLines = newContent ? newContent.split('\n') : [];
    
    // Simple diff algorithm - in production this would use a proper diff library
    const maxLines = Math.max(oldLines.length, newLines.length);
    const diffLines = [];
    
    for (let i = 0; i < maxLines; i++) {
      const oldLine = oldLines[i] || '';
      const newLine = newLines[i] || '';
      
      if (oldLine === newLine) {
        diffLines.push({ type: 'unchanged', content: oldLine });
      } else if (!oldLine) {
        diffLines.push({ type: 'added', content: newLine });
      } else if (!newLine) {
        diffLines.push({ type: 'deleted', content: oldLine });
      } else {
        diffLines.push({ type: 'deleted', content: oldLine });
        diffLines.push({ type: 'added', content: newLine });
      }
    }
    
    return diffLines;
  };

  return (
    <div className="jp-HistoryViewer-diffViewer">
      <div className="jp-HistoryViewer-diffViewer-header">
        <h3>{trans.__('Comparing versions')}</h3>
        <button
          className="jp-HistoryViewer-button jp-HistoryViewer-button-close"
          onClick={onClose}
          title={trans.__('Close diff viewer')}
        >
          ×
        </button>
      </div>
      
      <div className="jp-HistoryViewer-diffViewer-info">
        <div className="jp-HistoryViewer-diffViewer-from">
          <strong>{trans.__('From:')}</strong> {fromSnapshot.user.name} - {Time.formatHuman(fromSnapshot.timestamp)}
        </div>
        <div className="jp-HistoryViewer-diffViewer-to">
          <strong>{trans.__('To:')}</strong> {toSnapshot.user.name} - {Time.formatHuman(toSnapshot.timestamp)}
        </div>
      </div>

      <div className="jp-HistoryViewer-diffViewer-summary">
        <div className="jp-HistoryViewer-diffViewer-stats">
          <span className="jp-HistoryViewer-diffStat jp-HistoryViewer-diffStat-added">
            +{diff.added.length} {trans.__('added')}
          </span>
          <span className="jp-HistoryViewer-diffStat jp-HistoryViewer-diffStat-modified">
            ~{diff.modified.length} {trans.__('modified')}
          </span>
          <span className="jp-HistoryViewer-diffStat jp-HistoryViewer-diffStat-deleted">
            -{diff.deleted.length} {trans.__('deleted')}
          </span>
        </div>
      </div>

      <div className="jp-HistoryViewer-diffViewer-content">
        {diff.cellDiffs.map((cellDiff, index) => (
          <div key={index} className="jp-HistoryViewer-cellDiff">
            <div className="jp-HistoryViewer-cellDiff-header">
              <span className={`jp-HistoryViewer-cellDiff-type jp-HistoryViewer-cellDiff-type-${cellDiff.type}`}>
                {cellDiff.type}
              </span>
              <span className="jp-HistoryViewer-cellDiff-id">
                {cellDiff.cellId}
              </span>
            </div>
            
            {cellDiff.type === 'modified' && (
              <div className="jp-HistoryViewer-cellDiff-content">
                {formatDiffLines(cellDiff.oldContent, cellDiff.newContent).map((line, lineIndex) => (
                  <div
                    key={lineIndex}
                    className={`jp-HistoryViewer-diffLine jp-HistoryViewer-diffLine-${line.type}`}
                  >
                    <span className="jp-HistoryViewer-diffLine-indicator">
                      {line.type === 'added' && '+'}
                      {line.type === 'deleted' && '-'}
                      {line.type === 'unchanged' && ' '}
                    </span>
                    <span className="jp-HistoryViewer-diffLine-content">
                      {line.content}
                    </span>
                  </div>
                ))}
              </div>
            )}
            
            {cellDiff.type === 'added' && (
              <div className="jp-HistoryViewer-cellDiff-content">
                <div className="jp-HistoryViewer-diffLine jp-HistoryViewer-diffLine-added">
                  <span className="jp-HistoryViewer-diffLine-indicator">+</span>
                  <span className="jp-HistoryViewer-diffLine-content">
                    {cellDiff.newContent}
                  </span>
                </div>
              </div>
            )}
            
            {cellDiff.type === 'deleted' && (
              <div className="jp-HistoryViewer-cellDiff-content">
                <div className="jp-HistoryViewer-diffLine jp-HistoryViewer-diffLine-deleted">
                  <span className="jp-HistoryViewer-diffLine-indicator">-</span>
                  <span className="jp-HistoryViewer-diffLine-content">
                    {cellDiff.oldContent}
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Main HistoryViewer React component
 */
const HistoryViewer = ({ historyService, tracker, translator, onClose }: IHistoryViewerProps): JSX.Element => {
  const trans = translator.load('notebook');
  const [snapshots, setSnapshots] = useState<IHistorySnapshot[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<IHistorySnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffData, setDiffData] = useState<{
    fromSnapshot: IHistorySnapshot;
    toSnapshot: IHistorySnapshot;
    diff: any;
  } | null>(null);
  const [maxSnapshots, setMaxSnapshots] = useState(historyService.getMaxSnapshots());
  const [isEnabled, setIsEnabled] = useState(historyService.isEnabled());
  const [isCreatingSnapshot, setIsCreatingSnapshot] = useState(false);

  // Load initial snapshots
  useEffect(() => {
    const loadSnapshots = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const loadedSnapshots = await historyService.getSnapshots();
        setSnapshots(loadedSnapshots);
        if (loadedSnapshots.length > 0) {
          setSelectedSnapshot(loadedSnapshots[0]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : trans.__('Failed to load history'));
      } finally {
        setIsLoading(false);
      }
    };

    loadSnapshots();
  }, [historyService, trans]);

  // Listen for history changes
  useEffect(() => {
    const handleHistoryChanged = (sender: IHistoryService, newSnapshots: IHistorySnapshot[]) => {
      setSnapshots(newSnapshots);
      // Update selected snapshot if it's still in the list
      if (selectedSnapshot && !newSnapshots.find(s => s.id === selectedSnapshot.id)) {
        setSelectedSnapshot(newSnapshots[0] || null);
      }
    };

    historyService.historyChanged.connect(handleHistoryChanged);
    return () => {
      historyService.historyChanged.disconnect(handleHistoryChanged);
    };
  }, [historyService, selectedSnapshot]);

  // Handle snapshot selection
  const handleSnapshotSelect = useCallback((snapshot: IHistorySnapshot) => {
    setSelectedSnapshot(snapshot);
    setShowDiff(false);
    setDiffData(null);
  }, []);

  // Handle snapshot restoration
  const handleRestoreSnapshot = useCallback(async (snapshot: IHistorySnapshot) => {
    try {
      const shouldProceed = window.confirm(
        trans.__('Are you sure you want to restore to this version? This will create a new snapshot of the current state before restoring.')
      );
      
      if (!shouldProceed) return;

      await historyService.restoreSnapshot({
        snapshotId: snapshot.id,
        createSnapshot: true,
        restoreMode: 'full'
      });

      // Show success message
      const currentWidget = tracker.currentWidget;
      if (currentWidget) {
        // You could show a toast notification here
        console.log('Successfully restored to snapshot:', snapshot.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : trans.__('Failed to restore snapshot'));
    }
  }, [historyService, tracker, trans]);

  // Handle diff computation
  const handleShowDiff = useCallback(async (toSnapshot: IHistorySnapshot) => {
    if (!selectedSnapshot || selectedSnapshot.id === toSnapshot.id) {
      return;
    }

    try {
      const diff = await historyService.computeDiff(selectedSnapshot.id, toSnapshot.id);
      setDiffData({
        fromSnapshot: selectedSnapshot,
        toSnapshot: toSnapshot,
        diff
      });
      setShowDiff(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : trans.__('Failed to compute diff'));
    }
  }, [historyService, selectedSnapshot, trans]);

  // Handle creating new snapshot
  const handleCreateSnapshot = useCallback(async () => {
    try {
      setIsCreatingSnapshot(true);
      setError(null);
      const description = window.prompt(trans.__('Enter description for this snapshot (optional):'));
      if (description === null) return; // User cancelled
      
      await historyService.createSnapshot(description || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : trans.__('Failed to create snapshot'));
    } finally {
      setIsCreatingSnapshot(false);
    }
  }, [historyService, trans]);

  // Handle settings changes
  const handleMaxSnapshotsChange = useCallback((newMax: number) => {
    historyService.setMaxSnapshots(newMax);
    setMaxSnapshots(newMax);
  }, [historyService]);

  const handleEnabledChange = useCallback((enabled: boolean) => {
    historyService.setEnabled(enabled);
    setIsEnabled(enabled);
  }, [historyService]);

  // Memoized snapshot list
  const snapshotList = useMemo(() => {
    return snapshots.map(snapshot => (
      <HistorySnapshotItem
        key={snapshot.id}
        snapshot={snapshot}
        isSelected={selectedSnapshot?.id === snapshot.id}
        onSelect={() => handleSnapshotSelect(snapshot)}
        onRestore={() => handleRestoreSnapshot(snapshot)}
        onDiff={() => handleShowDiff(snapshot)}
        translator={translator}
      />
    ));
  }, [snapshots, selectedSnapshot, handleSnapshotSelect, handleRestoreSnapshot, handleShowDiff, translator]);

  if (showDiff && diffData) {
    return (
      <HistoryDiffViewer
        fromSnapshot={diffData.fromSnapshot}
        toSnapshot={diffData.toSnapshot}
        diff={diffData.diff}
        onClose={() => setShowDiff(false)}
        translator={translator}
      />
    );
  }

  return (
    <div className="jp-HistoryViewer">
      <div className="jp-HistoryViewer-header">
        <h2 className="jp-HistoryViewer-title">{trans.__('Version History')}</h2>
        {onClose && (
          <button
            className="jp-HistoryViewer-button jp-HistoryViewer-button-close"
            onClick={onClose}
            title={trans.__('Close history viewer')}
          >
            ×
          </button>
        )}
      </div>

      <div className="jp-HistoryViewer-toolbar">
        <button
          className="jp-HistoryViewer-button jp-HistoryViewer-button-primary"
          onClick={handleCreateSnapshot}
          disabled={isCreatingSnapshot || !isEnabled}
          title={trans.__('Create new snapshot')}
        >
          {isCreatingSnapshot ? trans.__('Creating...') : trans.__('Create Snapshot')}
        </button>
        
        <div className="jp-HistoryViewer-toolbar-spacer" />
        
        <div className="jp-HistoryViewer-settings">
          <label className="jp-HistoryViewer-setting">
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={(e) => handleEnabledChange(e.target.checked)}
            />
            {trans.__('Enable history tracking')}
          </label>
          
          <label className="jp-HistoryViewer-setting">
            {trans.__('Max snapshots:')}
            <input
              type="number"
              min="1"
              max="1000"
              value={maxSnapshots}
              onChange={(e) => handleMaxSnapshotsChange(parseInt(e.target.value, 10))}
              className="jp-HistoryViewer-numberInput"
            />
          </label>
        </div>
      </div>

      {error && (
        <div className="jp-HistoryViewer-error">
          <div className="jp-HistoryViewer-error-message">{error}</div>
          <button
            className="jp-HistoryViewer-button jp-HistoryViewer-button-small"
            onClick={() => setError(null)}
          >
            {trans.__('Dismiss')}
          </button>
        </div>
      )}

      <div className="jp-HistoryViewer-content">
        {isLoading ? (
          <div className="jp-HistoryViewer-loading">
            <div className="jp-HistoryViewer-spinner" />
            <span>{trans.__('Loading history...')}</span>
          </div>
        ) : snapshots.length === 0 ? (
          <div className="jp-HistoryViewer-empty">
            <div className="jp-HistoryViewer-empty-message">
              {isEnabled 
                ? trans.__('No snapshots yet. Create your first snapshot to track changes.')
                : trans.__('History tracking is disabled. Enable it to start tracking changes.')
              }
            </div>
          </div>
        ) : (
          <div className="jp-HistoryViewer-snapshots">
            {snapshotList}
          </div>
        )}
      </div>

      <div className="jp-HistoryViewer-footer">
        <div className="jp-HistoryViewer-info">
          {trans._n('%1 snapshot', '%1 snapshots', snapshots.length, snapshots.length)}
          {maxSnapshots > 0 && (
            <span> / {trans.__('max %1', maxSnapshots)}</span>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * A widget that wraps the HistoryViewer React component
 */
export class HistoryViewerWidget extends ReactWidget {
  private _historyService: IHistoryService;
  private _tracker: INotebookTracker;
  private _translator: ITranslator;

  constructor(options: {
    historyService: IHistoryService;
    tracker: INotebookTracker;
    translator: ITranslator;
  }) {
    super();
    this._historyService = options.historyService;
    this._tracker = options.tracker;
    this._translator = options.translator;
    
    this.addClass('jp-HistoryViewer-widget');
    this.title.label = this._translator.load('notebook').__('History');
    this.title.caption = this._translator.load('notebook').__('Notebook version history');
    this.title.closable = true;
    this.title.iconClass = 'jp-Icon jp-Icon-16 jp-HistoryViewer-icon';
  }

  protected render(): React.ReactElement {
    return (
      <HistoryViewer
        historyService={this._historyService}
        tracker={this._tracker}
        translator={this._translator}
        onClose={() => this.dispose()}
      />
    );
  }

  protected onBeforeHide(msg: Message): void {
    // Cleanup any resources if needed
    super.onBeforeHide(msg);
  }

  protected onBeforeShow(msg: Message): void {
    // Refresh data when showing the widget
    super.onBeforeShow(msg);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    super.dispose();
  }
}

/**
 * A namespace for HistoryViewerComponent static methods.
 */
export namespace HistoryViewerComponent {
  /**
   * Create a new HistoryViewerComponent widget
   *
   * @param historyService The history service
   * @param tracker The notebook tracker
   * @param translator The translator
   */
  export const create = (options: {
    historyService: IHistoryService;
    tracker: INotebookTracker;
    translator: ITranslator;
  }): HistoryViewerWidget => {
    return new HistoryViewerWidget(options);
  };
}