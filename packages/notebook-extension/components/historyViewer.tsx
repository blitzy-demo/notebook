/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * HistoryViewer React component for collaborative version history browsing.
 * Provides timeline display, diff visualization, virtual scrolling for performance,
 * and version restoration capabilities with cell-level granularity.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { FixedSizeList } from 'react-window';
import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { DiffViewer, DiffPanel, DiffModel } from '@jupyterlab/ui-components';

import { HistoryTracker } from 'packages/notebook/src/collab/history';
import { IHistoryTracker, IVersionSnapshot, ICollaborativeUser } from 'packages/notebook/src/tokens';

/**
 * Enumeration for different diff visualization modes
 */
export enum DiffMode {
  INLINE = 'inline',
  SIDE_BY_SIDE = 'side-by-side',
  UNIFIED = 'unified'
}

/**
 * Interface for history filter options
 */
export interface IHistoryFilterOptions {
  /**
   * Start date for filtering history entries
   */
  startDate?: Date;

  /**
   * End date for filtering history entries
   */
  endDate?: Date;

  /**
   * Filter by specific author ID
   */
  authorId?: string;

  /**
   * Filter by cell type (code, markdown, raw)
   */
  cellType?: 'code' | 'markdown' | 'raw';

  /**
   * Search term to filter by change content
   */
  searchTerm?: string;

  /**
   * Show only snapshots with specific change types
   */
  changeTypes?: ('added' | 'removed' | 'modified')[];

  /**
   * Minimum change threshold for filtering
   */
  minChanges?: number;

  /**
   * Maximum number of results to display
   */
  limit?: number;
}

/**
 * Interface for HistoryViewer component props
 */
export interface IHistoryViewerProps {
  /**
   * History tracker instance for version management
   */
  historyTracker: HistoryTracker;

  /**
   * Notebook tracker for monitoring active notebook
   */
  notebookTracker?: INotebookTracker;

  /**
   * Initial diff mode for visualization
   */
  initialDiffMode?: DiffMode;

  /**
   * Initial filter options
   */
  initialFilters?: IHistoryFilterOptions;

  /**
   * Maximum height for the virtual scrolled list
   */
  maxHeight?: number;

  /**
   * Whether to show restoration controls
   */
  allowRestore?: boolean;

  /**
   * Callback when version is selected
   */
  onVersionSelect?: (version: IVersionSnapshot) => void;

  /**
   * Callback when version is restored
   */
  onVersionRestore?: (version: IVersionSnapshot) => void;
}

/**
 * Interface for timeline entry data
 */
interface ITimelineEntry {
  snapshot: IVersionSnapshot;
  index: number;
  isExpanded: boolean;
  isSelected: boolean;
}

/**
 * Interface for diff computation state
 */
interface IDiffState {
  loading: boolean;
  fromVersion?: IVersionSnapshot;
  toVersion?: IVersionSnapshot;
  diffResult?: any;
  error?: string;
}

/**
 * Interface for restoration state
 */
interface IRestoreState {
  loading: boolean;
  targetVersion?: IVersionSnapshot;
  confirmDialog: boolean;
  error?: string;
}

/**
 * Component for displaying detailed version metadata
 */
const VersionMetadata: React.FC<{
  snapshot: IVersionSnapshot;
  historyTracker: HistoryTracker;
}> = ({ snapshot, historyTracker }) => {
  const [metadata, setMetadata] = useState<Record<string, any>>({});
  const [metadataLoading, setMetadataLoading] = useState(false);

  useEffect(() => {
    const loadMetadata = async () => {
      try {
        setMetadataLoading(true);
        const meta = await historyTracker.getVersionMetadata(snapshot.id);
        setMetadata(meta);
      } catch (err) {
        console.error('Failed to load version metadata:', err);
      } finally {
        setMetadataLoading(false);
      }
    };

    loadMetadata();
  }, [snapshot.id, historyTracker]);

  if (metadataLoading) {
    return (
      <div className="jp-HistoryViewer-entry-details">
        <div className="jp-HistoryViewer-metadata-loading">
          Loading metadata...
        </div>
      </div>
    );
  }

  return (
    <div className="jp-HistoryViewer-entry-details">
      <div className="jp-HistoryViewer-metadata">
        <div>Size: {snapshot.size} bytes</div>
        <div>Changes: {Object.keys(snapshot.cellChanges).length} cells</div>
        <div>ID: {snapshot.id.substring(0, 8)}...</div>

        {metadata.compressed && (
          <div>Compressed: Yes (original: {metadata.originalSize} bytes)</div>
        )}

        {metadata.type && (
          <div>Type: {metadata.type}</div>
        )}

        {metadata.attribution && (
          <div>Attribution: Enabled</div>
        )}

        {metadata.documentSize && (
          <div>Document Size: {metadata.documentSize} bytes</div>
        )}
      </div>

      <div className="jp-HistoryViewer-cell-changes">
        {Object.entries(snapshot.cellChanges).slice(0, 3).map(([cellId, change]: [string, any]) => (
          <div key={cellId} className="jp-HistoryViewer-cell-preview">
            <strong>{cellId}:</strong> {change.changeType || 'modified'}
            {change.content && (
              <div className="jp-HistoryViewer-cell-content-preview">
                {typeof change.content === 'string' ?
                  change.content.substring(0, 100) + (change.content.length > 100 ? '...' : '') :
                  'Binary content'
                }
              </div>
            )}
          </div>
        ))}
        {Object.keys(snapshot.cellChanges).length > 3 && (
          <div className="jp-HistoryViewer-more-changes">
            +{Object.keys(snapshot.cellChanges).length - 3} more changes
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Main HistoryViewer React component providing comprehensive version history browsing
 */
export const HistoryViewer: React.FC<IHistoryViewerProps> = ({
  historyTracker,
  notebookTracker,
  initialDiffMode = DiffMode.INLINE,
  initialFilters = {},
  maxHeight = 600,
  allowRestore = true,
  onVersionSelect,
  onVersionRestore
}) => {
  // Core state management
  const [versions, setVersions] = useState<IVersionSnapshot[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<IVersionSnapshot | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(initialDiffMode);
  const [filterOptions, setFilterOptions] = useState<IHistoryFilterOptions>(initialFilters);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  // Diff visualization state
  const [diffState, setDiffState] = useState<IDiffState>({ loading: false });

  // Version restoration state
  const [restoreState, setRestoreState] = useState<IRestoreState>({
    loading: false,
    confirmDialog: false
  });

  // Pagination for virtual scrolling and browsing
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 50 });
  const [currentPage, setCurrentPage] = useState(0);
  const [totalVersions, setTotalVersions] = useState(0);

  /**
   * Load version history from the history tracker using pagination
   */
  const loadHistory = useCallback(async (limit?: number, offset?: number) => {
    try {
      setLoading(true);
      setError(null);

      // Use browseVersions for efficient pagination
      const result = await historyTracker.browseVersions(offset || 0, limit || 50);

      if (offset === 0) {
        // First page load - replace all versions
        setVersions(result.versions);
      } else {
        // Subsequent pages - append to existing versions
        setVersions(prev => [...prev, ...result.versions]);
      }

      setTotalVersions(result.total);

      console.log(`Loaded ${result.versions.length} of ${result.total} version snapshots`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load history';
      setError(errorMessage);
      console.error('Error loading version history:', err);
    } finally {
      setLoading(false);
    }
  }, [historyTracker]);

  /**
   * Load more versions for infinite scrolling
   */
  const loadMoreVersions = useCallback(async () => {
    if (versions.length >= totalVersions || loading) {
      return;
    }

    await loadHistory(50, versions.length);
  }, [loadHistory, versions.length, totalVersions, loading]);

  /**
   * Capture a manual snapshot of the current state
   */
  const captureManualSnapshot = useCallback(async () => {
    try {
      setLoading(true);
      const snapshotId = await historyTracker.captureSnapshot({
        type: 'manual_snapshot',
        triggeredBy: 'user',
        source: 'history_viewer'
      });

      if (snapshotId) {
        // Refresh history to show the new snapshot
        await loadHistory();
        console.log(`Manual snapshot captured: ${snapshotId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to capture snapshot');
      console.error('Error capturing manual snapshot:', err);
    } finally {
      setLoading(false);
    }
  }, [historyTracker, loadHistory]);

  /**
   * Filter and search versions based on current criteria
   */
  const filteredVersions = useMemo(() => {
    let filtered = [...versions];

    // Apply date range filter
    if (filterOptions.startDate) {
      filtered = filtered.filter(v => v.timestamp >= filterOptions.startDate!);
    }
    if (filterOptions.endDate) {
      filtered = filtered.filter(v => v.timestamp <= filterOptions.endDate!);
    }

    // Apply author filter
    if (filterOptions.authorId) {
      filtered = filtered.filter(v => v.author.userId === filterOptions.authorId);
    }

    // Apply search term filter
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(v =>
        v.changeSummary.toLowerCase().includes(term) ||
        v.author.displayName.toLowerCase().includes(term) ||
        v.id.toLowerCase().includes(term)
      );
    }

    // Apply change type filter
    if (filterOptions.changeTypes && filterOptions.changeTypes.length > 0) {
      filtered = filtered.filter(v => {
        const cellChanges = Object.values(v.cellChanges);
        return cellChanges.some((change: any) =>
          filterOptions.changeTypes!.includes(change.changeType)
        );
      });
    }

    // Apply minimum changes filter
    if (filterOptions.minChanges !== undefined) {
      filtered = filtered.filter(v => {
        const changeCount = Object.keys(v.cellChanges).length;
        return changeCount >= filterOptions.minChanges!;
      });
    }

    // Apply limit
    if (filterOptions.limit) {
      filtered = filtered.slice(0, filterOptions.limit);
    }

    return filtered;
  }, [versions, filterOptions, searchTerm]);

  /**
   * Prepare timeline entries for virtual scrolling
   */
  const timelineEntries: ITimelineEntry[] = useMemo(() => {
    return filteredVersions.map((snapshot, index) => ({
      snapshot,
      index,
      isExpanded: expandedItems.has(snapshot.id),
      isSelected: selectedVersion?.id === snapshot.id
    }));
  }, [filteredVersions, expandedItems, selectedVersion]);

  /**
   * Handle version selection and diff computation
   */
  const handleVersionSelect = useCallback(async (version: IVersionSnapshot) => {
    setSelectedVersion(version);
    onVersionSelect?.(version);

    // Compute diff with previous version if available
    const currentIndex = filteredVersions.findIndex(v => v.id === version.id);
    if (currentIndex > 0) {
      const previousVersion = filteredVersions[currentIndex - 1];

      setDiffState({ loading: true });

      try {
        const diffResult = await historyTracker.getDiff(previousVersion.id, version.id);
        setDiffState({
          loading: false,
          fromVersion: previousVersion,
          toVersion: version,
          diffResult
        });
      } catch (err) {
        setDiffState({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to compute diff'
        });
      }
    } else {
      // First version - show as initial state
      setDiffState({
        loading: false,
        fromVersion: undefined,
        toVersion: version,
        diffResult: {
          cellDiffs: version.cellChanges,
          summary: {
            cellsAdded: Object.keys(version.cellChanges).length,
            cellsRemoved: 0,
            cellsModified: 0,
            totalChanges: Object.keys(version.cellChanges).length
          }
        }
      });
    }
  }, [filteredVersions, historyTracker, onVersionSelect]);

  /**
   * Toggle expansion of timeline entry
   */
  const toggleExpansion = useCallback((versionId: string) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(versionId)) {
        newSet.delete(versionId);
      } else {
        newSet.add(versionId);
      }
      return newSet;
    });
  }, []);

  /**
   * Handle version restoration with confirmation
   */
  const handleRestoreVersion = useCallback(async (version: IVersionSnapshot) => {
    setRestoreState({
      loading: false,
      targetVersion: version,
      confirmDialog: true
    });
  }, []);

  /**
   * Confirm and execute version restoration
   */
  const confirmRestore = useCallback(async () => {
    if (!restoreState.targetVersion) return;

    try {
      setRestoreState(prev => ({ ...prev, loading: true, error: undefined }));

      const result = await historyTracker.restoreVersion(restoreState.targetVersion.id);

      if (result.success) {
        onVersionRestore?.(restoreState.targetVersion);
        await loadHistory(); // Refresh history

        setRestoreState({
          loading: false,
          confirmDialog: false,
          targetVersion: undefined
        });
      } else {
        setRestoreState(prev => ({
          ...prev,
          loading: false,
          error: result.error || 'Restoration failed'
        }));
      }
    } catch (err) {
      setRestoreState(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Restoration failed'
      }));
    }
  }, [restoreState.targetVersion, historyTracker, onVersionRestore, loadHistory]);

  /**
   * Cancel restoration dialog
   */
  const cancelRestore = useCallback(() => {
    setRestoreState({
      loading: false,
      confirmDialog: false,
      targetVersion: undefined
    });
  }, []);

  /**
   * Timeline entry renderer for virtual scrolling
   */
  const renderTimelineEntry = useCallback(({ index, style }: { index: number; style: React.CSSProperties }) => {
    const entry = timelineEntries[index];
    if (!entry) return null;

    const { snapshot, isExpanded, isSelected } = entry;

    return (
      <div
        style={style}
        className={`jp-HistoryViewer-entry ${isSelected ? 'jp-mod-selected' : ''}`}
        onClick={() => handleVersionSelect(snapshot)}
      >
        <div className="jp-HistoryViewer-entry-header">
          <button
            className="jp-HistoryViewer-expand-button"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpansion(snapshot.id);
            }}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} version details`}
          >
            {isExpanded ? '▼' : '▶'}
          </button>

          <div className="jp-HistoryViewer-entry-info">
            <div className="jp-HistoryViewer-entry-timestamp">
              {snapshot.timestamp.toLocaleString()}
            </div>
            <div className="jp-HistoryViewer-entry-author">
              {snapshot.author.displayName}
            </div>
            <div className="jp-HistoryViewer-entry-summary">
              {snapshot.changeSummary}
            </div>
          </div>

          {allowRestore && (
            <button
              className="jp-HistoryViewer-restore-button"
              onClick={(e) => {
                e.stopPropagation();
                handleRestoreVersion(snapshot);
              }}
              title="Restore this version"
              disabled={restoreState.loading}
            >
              🔄
            </button>
          )}
        </div>

        {isExpanded && (
          <VersionMetadata
            snapshot={snapshot}
            historyTracker={historyTracker}
          />
        )}
      </div>
    );
  }, [timelineEntries, handleVersionSelect, toggleExpansion, allowRestore, handleRestoreVersion, restoreState.loading]);

  /**
   * Render diff visualization panel
   */
  const renderDiffPanel = useCallback(() => {
    if (!diffState.fromVersion && !diffState.toVersion) {
      return (
        <div className="jp-HistoryViewer-diff-empty">
          <p>Select a version to view changes</p>
        </div>
      );
    }

    if (diffState.loading) {
      return (
        <div className="jp-HistoryViewer-diff-loading">
          <p>Computing differences...</p>
        </div>
      );
    }

    if (diffState.error) {
      return (
        <div className="jp-HistoryViewer-diff-error">
          <p>Error: {diffState.error}</p>
        </div>
      );
    }

    const { diffResult, fromVersion, toVersion } = diffState;
    if (!diffResult) return null;

    return (
      <div className="jp-HistoryViewer-diff-panel">
        <div className="jp-HistoryViewer-diff-header">
          <h3>
            {fromVersion ? `${fromVersion.id.substring(0, 8)} → ${toVersion?.id.substring(0, 8)}`
                         : `Initial state (${toVersion?.id.substring(0, 8)})`}
          </h3>

          <div className="jp-HistoryViewer-diff-controls">
            <select
              value={diffMode}
              onChange={(e) => setDiffMode(e.target.value as DiffMode)}
              className="jp-HistoryViewer-diff-mode-select"
            >
              <option value={DiffMode.INLINE}>Inline</option>
              <option value={DiffMode.SIDE_BY_SIDE}>Side by Side</option>
              <option value={DiffMode.UNIFIED}>Unified</option>
            </select>
          </div>
        </div>

        <div className="jp-HistoryViewer-diff-summary">
          <span className="jp-diff-added">+{diffResult.summary.cellsAdded}</span>
          <span className="jp-diff-removed">-{diffResult.summary.cellsRemoved}</span>
          <span className="jp-diff-modified">~{diffResult.summary.cellsModified}</span>
        </div>

        <div className="jp-HistoryViewer-diff-content">
          {Object.entries(diffResult.cellDiffs).map(([cellId, diff]: [string, any]) => {
            // Create DiffModel for JupyterLab UI components
            const diffModel = new DiffModel({
              original: diff.oldContent || '',
              modified: diff.newContent || '',
              originalTitle: fromVersion ? `${fromVersion.id.substring(0, 8)}` : 'Empty',
              modifiedTitle: toVersion ? `${toVersion.id.substring(0, 8)}` : 'Current'
            });

            return (
              <div key={cellId} className={`jp-HistoryViewer-cell-diff jp-diff-${diff.changeType}`}>
                <div className="jp-HistoryViewer-cell-diff-header">
                  <strong>Cell {cellId}</strong> - {diff.changeType}
                </div>

                <div className="jp-HistoryViewer-cell-diff-content">
                  {diffMode === DiffMode.SIDE_BY_SIDE ? (
                    <DiffPanel model={diffModel} />
                  ) : diffMode === DiffMode.UNIFIED ? (
                    <DiffViewer model={diffModel} />
                  ) : (
                    // Inline mode - custom implementation for inline diffs
                    <div className="jp-diff-inline">
                      {diff.changes?.map((change: any, idx: number) => (
                        <div
                          key={idx}
                          className={`jp-diff-line ${
                            change.added ? 'jp-diff-added' :
                            change.removed ? 'jp-diff-removed' : ''
                          }`}
                        >
                          <span className="jp-diff-line-marker">
                            {change.added ? '+' : change.removed ? '-' : ' '}
                          </span>
                          <pre>{change.value}</pre>
                        </div>
                      )) || (
                        <div className="jp-diff-unified-content">
                          <DiffViewer model={diffModel} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }, [diffState, diffMode]);

  /**
   * Render filter controls
   */
  const renderFilterControls = useCallback(() => (
    <div className="jp-HistoryViewer-filters">
      <div className="jp-HistoryViewer-search">
        <input
          type="text"
          placeholder="Search history..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="jp-HistoryViewer-search-input"
        />
      </div>

      <div className="jp-HistoryViewer-filter-controls">
        <select
          value={filterOptions.authorId || ''}
          onChange={(e) => setFilterOptions(prev => ({
            ...prev,
            authorId: e.target.value || undefined
          }))}
          className="jp-HistoryViewer-author-filter"
        >
          <option value="">All authors</option>
          {Array.from(new Set(versions.map(v => v.author.userId))).map(authorId => {
            const author = versions.find(v => v.author.userId === authorId)?.author;
            return (
              <option key={authorId} value={authorId}>
                {author?.displayName || authorId}
              </option>
            );
          })}
        </select>

        <input
          type="date"
          value={filterOptions.startDate?.toISOString().split('T')[0] || ''}
          onChange={(e) => setFilterOptions(prev => ({
            ...prev,
            startDate: e.target.value ? new Date(e.target.value) : undefined
          }))}
          className="jp-HistoryViewer-date-filter"
          placeholder="Start date"
        />

        <input
          type="date"
          value={filterOptions.endDate?.toISOString().split('T')[0] || ''}
          onChange={(e) => setFilterOptions(prev => ({
            ...prev,
            endDate: e.target.value ? new Date(e.target.value) : undefined
          }))}
          className="jp-HistoryViewer-date-filter"
          placeholder="End date"
        />

        <button
          onClick={() => {
            setFilterOptions({});
            setSearchTerm('');
          }}
          className="jp-HistoryViewer-clear-filters"
        >
          Clear Filters
        </button>
      </div>
    </div>
  ), [searchTerm, filterOptions, versions]);

  /**
   * Render restoration confirmation dialog
   */
  const renderRestoreDialog = useCallback(() => {
    if (!restoreState.confirmDialog || !restoreState.targetVersion) return null;

    return (
      <div className="jp-HistoryViewer-restore-dialog-overlay">
        <div className="jp-HistoryViewer-restore-dialog">
          <h3>Confirm Version Restoration</h3>

          <div className="jp-HistoryViewer-restore-info">
            <p>
              Are you sure you want to restore to version from{' '}
              <strong>{restoreState.targetVersion.timestamp.toLocaleString()}</strong>?
            </p>
            <p>
              Author: <strong>{restoreState.targetVersion.author.displayName}</strong>
            </p>
            <p>
              Changes: <strong>{restoreState.targetVersion.changeSummary}</strong>
            </p>
            <p className="jp-HistoryViewer-restore-warning">
              ⚠️ This will modify the current notebook content. A checkpoint will be created before restoration.
            </p>
          </div>

          {restoreState.error && (
            <div className="jp-HistoryViewer-restore-error">
              Error: {restoreState.error}
            </div>
          )}

          <div className="jp-HistoryViewer-restore-buttons">
            <button
              onClick={cancelRestore}
              disabled={restoreState.loading}
              className="jp-HistoryViewer-button jp-HistoryViewer-button-secondary"
            >
              Cancel
            </button>
            <button
              onClick={confirmRestore}
              disabled={restoreState.loading}
              className="jp-HistoryViewer-button jp-HistoryViewer-button-primary"
            >
              {restoreState.loading ? 'Restoring...' : 'Restore Version'}
            </button>
          </div>
        </div>
      </div>
    );
  }, [restoreState, cancelRestore, confirmRestore]);

  // Effect: Load initial history and set up version change listener
  useEffect(() => {
    loadHistory();

    // Listen for new versions
    const handleVersionChange = (snapshot: IVersionSnapshot) => {
      setVersions(prev => [snapshot, ...prev]);
    };

    historyTracker.onVersionChange.connect(handleVersionChange);

    return () => {
      historyTracker.onVersionChange.disconnect(handleVersionChange);
    };
  }, [historyTracker, loadHistory]);

  // Effect: Monitor active notebook changes
  useEffect(() => {
    if (!notebookTracker) return;

    const handleNotebookChange = () => {
      // Reload history when active notebook changes
      loadHistory();
    };

    notebookTracker.currentChanged.connect(handleNotebookChange);

    return () => {
      notebookTracker.currentChanged.disconnect(handleNotebookChange);
    };
  }, [notebookTracker, loadHistory]);

  // Handle any critical errors in component lifecycle
  if (error && versions.length === 0 && !loading) {
    return (
      <div className="jp-HistoryViewer jp-HistoryViewer-error-state">
        <div className="jp-HistoryViewer-error-message">
          <h3>Failed to Load Version History</h3>
          <p>{error}</p>
          <button
            onClick={() => loadHistory()}
            className="jp-HistoryViewer-button jp-HistoryViewer-button-primary"
          >
            Retry Loading History
          </button>
        </div>
      </div>
    );
  }

  // Render main component
  return (
    <div className="jp-HistoryViewer">
      <div className="jp-HistoryViewer-header">
        <h2>Version History</h2>
        <div className="jp-HistoryViewer-header-controls">
          <button
            onClick={() => captureManualSnapshot()}
            disabled={loading}
            className="jp-HistoryViewer-capture"
            title="Capture current state as snapshot"
          >
            📸 Capture
          </button>
          <button
            onClick={() => loadHistory()}
            disabled={loading}
            className="jp-HistoryViewer-refresh"
            title="Refresh history"
          >
            {loading ? '⟳' : '↻'}
          </button>
        </div>
      </div>

      {renderFilterControls()}

      {error && (
        <div className="jp-HistoryViewer-error">
          <p>Error: {error}</p>
          <button onClick={() => loadHistory()}>Retry</button>
        </div>
      )}

      <div className="jp-HistoryViewer-content">
        <div className="jp-HistoryViewer-timeline">
          <div className="jp-HistoryViewer-timeline-header">
            <h3>Timeline ({filteredVersions.length} versions)</h3>
          </div>

          {loading ? (
            <div className="jp-HistoryViewer-loading">
              <p>Loading version history...</p>
            </div>
          ) : timelineEntries.length === 0 ? (
            <div className="jp-HistoryViewer-empty">
              <p>No version history available</p>
            </div>
          ) : (
            <FixedSizeList
              height={maxHeight}
              itemCount={timelineEntries.length}
              itemSize={80}
              className="jp-HistoryViewer-virtual-list"
              onItemsRendered={({ visibleStopIndex }) => {
                // Load more items when approaching the end
                if (visibleStopIndex >= timelineEntries.length - 5 &&
                    versions.length < totalVersions &&
                    !loading) {
                  loadMoreVersions();
                }
              }}
            >
              {renderTimelineEntry}
            </FixedSizeList>
          )}

          {versions.length < totalVersions && (
            <div className="jp-HistoryViewer-load-more">
              <button
                onClick={loadMoreVersions}
                disabled={loading}
                className="jp-HistoryViewer-load-more-button"
              >
                {loading ? 'Loading...' : `Load More (${totalVersions - versions.length} remaining)`}
              </button>
            </div>
          )}
        </div>

        <div className="jp-HistoryViewer-diff">
          {renderDiffPanel()}
        </div>
      </div>

      {renderRestoreDialog()}
    </div>
  );
};

/**
 * Lumino widget wrapper for the HistoryViewer component
 * Following the pattern established in trusted.tsx
 */
export namespace HistoryViewerComponent {
  /**
   * Create a new HistoryViewer widget
   *
   * @param historyTracker - The history tracker instance
   * @param notebookTracker - Optional notebook tracker
   * @param options - Additional component options
   */
  export const create = ({
    historyTracker,
    notebookTracker,
    ...options
  }: {
    historyTracker: HistoryTracker;
    notebookTracker?: INotebookTracker;
  } & Partial<IHistoryViewerProps>): ReactWidget => {
    return ReactWidget.create(
      <HistoryViewer
        historyTracker={historyTracker}
        notebookTracker={notebookTracker}
        {...options}
      />
    );
  };
}
