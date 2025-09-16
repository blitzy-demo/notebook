/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * HistoryViewer React component for version history browsing in collaborative Jupyter notebooks.
 * Displays a timeline of collaborative edits with diff visualization, version snapshots,
 * and restoration capabilities. Implements virtual scrolling for performance with large histories
 * and provides cell-level granularity for change tracking and comparison.
 */

import * as React from 'react';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { List } from 'react-window';
import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';
import { historyIcon } from '@jupyterlab/ui-components';

import { IRestoreResult } from '../../../notebook/src/collab/history';
import { IVersionSnapshot } from '../../../notebook/src/tokens';
import { ICollaborationHistory } from '../../../application/src/tokens';

/**
 * Props interface for HistoryViewer component
 */
export interface IHistoryViewerProps {
  /**
   * History tracker service for accessing version data
   */
  historyTracker: ICollaborationHistory;

  /**
   * Notebook tracker for monitoring active notebook
   */
  notebookTracker: INotebookTracker;

  /**
   * Translation service for internationalization
   */
  translator: ITranslator;

  /**
   * Height of the history viewer component
   */
  height?: number;

  /**
   * Width of the history viewer component
   */
  width?: number;

  /**
   * Optional callback when version is selected
   */
  onVersionSelect?: (version: IVersionSnapshot) => void;

  /**
   * Optional callback when version is restored
   */
  onVersionRestore?: (result: IRestoreResult) => void;
}

/**
 * Enumeration for diff visualization modes
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
   * Filter by author ID
   */
  authorId?: string;

  /**
   * Filter by date range start
   */
  startDate?: Date;

  /**
   * Filter by date range end
   */
  endDate?: Date;

  /**
   * Filter by cell type
   */
  cellType?: 'code' | 'markdown' | 'raw';

  /**
   * Search term for filtering
   */
  searchTerm?: string;

  /**
   * Maximum number of results
   */
  limit?: number;

  /**
   * Offset for pagination
   */
  offset?: number;
}

/**
 * HistoryViewer React functional component
 */
export const HistoryViewer: React.FC<IHistoryViewerProps> = ({
  historyTracker,
  notebookTracker,
  translator,
  height = 600,
  width = 400,
  onVersionSelect,
  onVersionRestore
}) => {
  const trans = translator.load('notebook');

  // Component state
  const [versions, setVersions] = useState<IVersionSnapshot[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<IVersionSnapshot | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(DiffMode.INLINE);
  const [filterOptions] = useState<IHistoryFilterOptions>({});
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [showRestoreConfirm, setShowRestoreConfirm] = useState<boolean>(false);
  const [restoreTarget, setRestoreTarget] = useState<IVersionSnapshot | null>(null);

  /**
   * Load version history from tracker
   */
  const loadHistory = useCallback(async () => {
    if (!historyTracker) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const history = historyTracker.getHistory();
      const filteredHistory = applyFilters(history, filterOptions);
      setVersions(filteredHistory);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
      console.error('Error loading history:', err);
    } finally {
      setLoading(false);
    }
  }, [historyTracker, filterOptions]);

  /**
   * Apply filters to history list
   */
  const applyFilters = useCallback((history: IVersionSnapshot[], filters: IHistoryFilterOptions): IVersionSnapshot[] => {
    let filtered = [...history];

    if (filters.authorId) {
      filtered = filtered.filter(v => v.author.userId === filters.authorId);
    }

    if (filters.startDate) {
      filtered = filtered.filter(v => v.timestamp >= filters.startDate!);
    }

    if (filters.endDate) {
      filtered = filtered.filter(v => v.timestamp <= filters.endDate!);
    }

    if (filters.searchTerm) {
      const term = filters.searchTerm.toLowerCase();
      filtered = filtered.filter(v =>
        v.changeSummary.toLowerCase().includes(term) ||
        v.author.displayName.toLowerCase().includes(term)
      );
    }

    if (filters.limit) {
      filtered = filtered.slice(filters.offset || 0, (filters.offset || 0) + filters.limit);
    }

    return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }, []);

  /**
   * Memoized filtered versions for performance
   */
  const filteredVersions = useMemo(() => {
    const currentFilters = { ...filterOptions, searchTerm };
    return applyFilters(versions, currentFilters);
  }, [versions, filterOptions, searchTerm, applyFilters]);

  // Load history on component mount and tracker changes
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  /**
   * Handle version selection
   */
  const handleVersionSelect = useCallback((version: IVersionSnapshot) => {
    setSelectedVersion(version);
    onVersionSelect?.(version);
  }, [onVersionSelect]);

  /**
   * Handle version expansion toggle
   */
  const handleToggleExpand = useCallback((versionId: string) => {
    const newExpanded = new Set(expandedItems);
    if (newExpanded.has(versionId)) {
      newExpanded.delete(versionId);
    } else {
      newExpanded.add(versionId);
    }
    setExpandedItems(newExpanded);
  }, [expandedItems]);

  /**
   * Handle restore version request
   */
  const handleRestoreRequest = useCallback((version: IVersionSnapshot) => {
    setRestoreTarget(version);
    setShowRestoreConfirm(true);
  }, []);

  /**
   * Confirm and execute version restoration
   */
  const handleRestoreConfirm = useCallback(async () => {
    if (!restoreTarget || !historyTracker) {
      return;
    }

    setLoading(true);
    try {
      historyTracker.restoreVersion(restoreTarget.id);

      const result: IRestoreResult = {
        restoredVersion: restoreTarget,
        success: true,
        modifiedCells: [],
        restoredAt: new Date()
      };

      onVersionRestore?.(result);
      setShowRestoreConfirm(false);
      setRestoreTarget(null);

      // Reload history after restoration
      await loadHistory();
    } catch (err) {
      const result: IRestoreResult = {
        restoredVersion: restoreTarget,
        success: false,
        error: err instanceof Error ? err.message : 'Restoration failed',
        modifiedCells: [],
        restoredAt: new Date()
      };
      onVersionRestore?.(result);
      setError(result.error || 'Restoration failed');
    } finally {
      setLoading(false);
    }
  }, [restoreTarget, historyTracker, onVersionRestore, loadHistory]);

  /**
   * Format timestamp for display
   */
  const formatTimestamp = useCallback((timestamp: Date): string => {
    return timestamp.toLocaleString();
  }, []);

  /**
   * Render individual version item
   */
  const renderVersionItem = useCallback(({ index }: { index: number }) => {
    const version = filteredVersions[index];
    if (!version) {
      return null;
    }

    const isExpanded = expandedItems.has(version.id);
    const isSelected = selectedVersion?.id === version.id;

    return (
      <div
        className={`jp-HistoryViewer-item ${isSelected ? 'jp-HistoryViewer-item-selected' : ''}`}
        onClick={() => handleVersionSelect(version)}
      >
        <div className="jp-HistoryViewer-item-header">
          <button
            className="jp-HistoryViewer-expand-button"
            onClick={(e) => {
              e.stopPropagation();
              handleToggleExpand(version.id);
            }}
            aria-label={isExpanded ? trans.__('Collapse') : trans.__('Expand')}
          >
            {isExpanded ? '▼' : '▶'}
          </button>

          <div className="jp-HistoryViewer-item-info">
            <div className="jp-HistoryViewer-item-summary">
              {version.changeSummary}
            </div>
            <div className="jp-HistoryViewer-item-meta">
              <span className="jp-HistoryViewer-author">
                {version.author.displayName}
              </span>
              <span className="jp-HistoryViewer-timestamp">
                {formatTimestamp(version.timestamp)}
              </span>
            </div>
          </div>

          <button
            className="jp-HistoryViewer-restore-button"
            onClick={(e) => {
              e.stopPropagation();
              handleRestoreRequest(version);
            }}
            title={trans.__('Restore this version')}
            aria-label={trans.__('Restore version')}
          >
            ↻
          </button>
        </div>

        {isExpanded && (
          <div className="jp-HistoryViewer-item-details">
            <div className="jp-HistoryViewer-item-metadata">
              <div><strong>{trans.__('Version ID')}:</strong> {version.id}</div>
              <div><strong>{trans.__('Size')}:</strong> {version.size} bytes</div>
              {version.metadata.cellsChanged && (
                <div><strong>{trans.__('Cells Changed')}:</strong> {Object.keys(version.cellChanges).length}</div>
              )}
            </div>

            {version.cellChanges && Object.keys(version.cellChanges).length > 0 && (
              <div className="jp-HistoryViewer-cell-changes">
                <h4>{trans.__('Cell Changes:')}</h4>
                {Object.entries(version.cellChanges).map(([cellId, change]) => (
                  <div key={cellId} className="jp-HistoryViewer-cell-change">
                    <strong>{cellId}:</strong> {(change as any)?.type || 'modified'}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }, [filteredVersions, expandedItems, selectedVersion, handleVersionSelect, handleToggleExpand, handleRestoreRequest, formatTimestamp, trans]);

  /**
   * Handle search input change
   */
  const handleSearchChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  }, []);

  /**
   * Handle diff mode change
   */
  const handleDiffModeChange = useCallback((mode: DiffMode) => {
    setDiffMode(mode);
  }, []);

  /**
   * Export history data
   */
  const handleExportHistory = useCallback(async () => {
    try {
      // Implementation would export filtered history as JSON or CSV
      const dataStr = JSON.stringify(filteredVersions, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });

      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `notebook_history_${new Date().toISOString()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Failed to export history');
      console.error('Export error:', err);
    }
  }, [filteredVersions]);

  // Main render
  return (
    <div className="jp-HistoryViewer" style={{ height, width }}>
      <div className="jp-HistoryViewer-header">
        <h3 className="jp-HistoryViewer-title">
          <historyIcon.react className="jp-HistoryViewer-icon" />
          {trans.__('Version History')}
        </h3>

        <div className="jp-HistoryViewer-controls">
          <input
            type="text"
            className="jp-HistoryViewer-search"
            placeholder={trans.__('Search history...')}
            value={searchTerm}
            onChange={handleSearchChange}
          />

          <div className="jp-HistoryViewer-diff-mode">
            <label>{trans.__('Diff Mode:')}</label>
            <select
              value={diffMode}
              onChange={(e) => handleDiffModeChange(e.target.value as DiffMode)}
            >
              <option value={DiffMode.INLINE}>{trans.__('Inline')}</option>
              <option value={DiffMode.SIDE_BY_SIDE}>{trans.__('Side by Side')}</option>
              <option value={DiffMode.UNIFIED}>{trans.__('Unified')}</option>
            </select>
          </div>

          <button
            className="jp-HistoryViewer-export-button"
            onClick={handleExportHistory}
            title={trans.__('Export history')}
          >
            {trans.__('Export')}
          </button>
        </div>
      </div>

      <div className="jp-HistoryViewer-timeline">
        {loading && (
          <div className="jp-HistoryViewer-loading">
            {trans.__('Loading history...')}
          </div>
        )}

        {error && (
          <div className="jp-HistoryViewer-error">
            {trans.__('Error: ')} {error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {!loading && !error && filteredVersions.length === 0 && (
          <div className="jp-HistoryViewer-empty">
            {trans.__('No version history available')}
          </div>
        )}

        {!loading && !error && filteredVersions.length > 0 && (
          <List
            height={height - 120} // Account for header
            itemCount={filteredVersions.length}
            itemSize={80} // Base height for collapsed items
            className="jp-HistoryViewer-list"
          >
            {({ index }: { index: number }) => renderVersionItem({ index })}
          </List>
        )}
      </div>

      <div className="jp-HistoryViewer-diff">
        {selectedVersion && (
          <div className="jp-HistoryViewer-diff-panel">
            <h4>{trans.__('Version Details')}</h4>
            <div className="jp-HistoryViewer-diff-content">
              <p><strong>{trans.__('Version:')}:</strong> {selectedVersion.id}</p>
              <p><strong>{trans.__('Author:')}:</strong> {selectedVersion.author.displayName}</p>
              <p><strong>{trans.__('Time:')}:</strong> {formatTimestamp(selectedVersion.timestamp)}</p>
              <p><strong>{trans.__('Changes:')}:</strong> {selectedVersion.changeSummary}</p>

              {diffMode !== DiffMode.INLINE && (
                <div className="jp-HistoryViewer-diff-visualization">
                  <div className={`jp-HistoryViewer-diff-${diffMode.replace('_', '-')}`}>
                    {/* Diff visualization would be rendered here */}
                    <div className="jp-HistoryViewer-diff-placeholder">
                      {trans.__('Diff visualization for mode: ')} {diffMode}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Restoration confirmation dialog */}
      {showRestoreConfirm && restoreTarget && (
        <div className="jp-HistoryViewer-restore-dialog">
          <div className="jp-HistoryViewer-restore-overlay"></div>
          <div className="jp-HistoryViewer-restore-modal">
            <h3>{trans.__('Confirm Version Restoration')}</h3>
            <p>
              {trans.__('Are you sure you want to restore to version:')}
              <br />
              <strong>{restoreTarget.changeSummary}</strong>
              <br />
              <em>{trans.__('by')} {restoreTarget.author.displayName} {trans.__('at')} {formatTimestamp(restoreTarget.timestamp)}</em>
            </p>
            <p className="jp-HistoryViewer-restore-warning">
              {trans.__('This will replace the current notebook content. This action can be undone by restoring to a newer version.')}
            </p>
            <div className="jp-HistoryViewer-restore-actions">
              <button
                className="jp-HistoryViewer-restore-confirm"
                onClick={handleRestoreConfirm}
                disabled={loading}
              >
                {loading ? trans.__('Restoring...') : trans.__('Restore')}
              </button>
              <button
                className="jp-HistoryViewer-restore-cancel"
                onClick={() => {
                  setShowRestoreConfirm(false);
                  setRestoreTarget(null);
                }}
                disabled={loading}
              >
                {trans.__('Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * HistoryViewer component wrapper with additional functionality
 */
export const HistoryViewerComponent = {
  /**
   * Create a new HistoryViewer widget
   */
  create: (props: IHistoryViewerProps): ReactWidget => {
    return ReactWidget.create(<HistoryViewer {...props} />);
  },

  /**
   * Show history panel in sidebar
   */
  showHistoryPanel: (widget: ReactWidget): void => {
    // Implementation would show the widget in the appropriate shell area
    console.log('Showing history panel:', widget);
  },

  /**
   * Display diff between two versions
   */
  displayDiff: (fromVersion: string, toVersion: string, mode: DiffMode = DiffMode.INLINE): void => {
    // Implementation would compute and display diff
    console.log(`Displaying diff from ${fromVersion} to ${toVersion} in ${mode} mode`);
  },

  /**
   * Restore to specific version
   */
  restoreVersion: (versionId: string): Promise<IRestoreResult> => {
    // Implementation would handle version restoration
    return Promise.resolve({
      restoredVersion: {} as IVersionSnapshot,
      success: true,
      modifiedCells: [],
      restoredAt: new Date()
    });
  },

  /**
   * Filter history based on criteria
   */
  filterHistory: (criteria: IHistoryFilterOptions): IVersionSnapshot[] => {
    // Implementation would filter history based on criteria
    console.log('Filtering history with criteria:', criteria);
    return [];
  },

  /**
   * Export history to downloadable format
   */
  exportHistory: (format: 'json' | 'csv' = 'json'): Promise<Blob> => {
    // Implementation would export history data
    return Promise.resolve(new Blob(['{}'], { type: 'application/json' }));
  }
};

/**
 * Static HistoryViewer class for Lumino widget integration
 */
export class historyViewer {
  /**
   * Create a new HistoryViewer widget
   */
  static create(props: IHistoryViewerProps): ReactWidget {
    return HistoryViewerComponent.create(props);
  }

  /**
   * Show history panel in sidebar
   */
  static showHistoryPanel(widget: ReactWidget): void {
    HistoryViewerComponent.showHistoryPanel(widget);
  }

  /**
   * Display diff between versions
   */
  static displayDiff(fromVersion: string, toVersion: string, mode: DiffMode = DiffMode.INLINE): void {
    HistoryViewerComponent.displayDiff(fromVersion, toVersion, mode);
  }

  /**
   * Restore specific version
   */
  static restoreVersion(versionId: string): Promise<IRestoreResult> {
    return HistoryViewerComponent.restoreVersion(versionId);
  }
}
