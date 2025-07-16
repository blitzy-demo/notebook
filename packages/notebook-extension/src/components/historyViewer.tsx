// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { closeIcon } from '@jupyterlab/ui-components';
import { Time } from '@jupyterlab/coreutils';
import { diffLines } from 'diff';
import { IVersionMetadata } from '../../../notebook/src/collab/history';
import { YjsNotebookProvider } from '../../../notebook/src/collab/provider';

// Import CSS styles
import '../style/historyViewer.css';

/**
 * Interface for HistoryViewer component properties
 */
interface IHistoryViewerProps {
  /** Change history system for accessing version data */
  history: any; // ChangeHistory instance
  /** Current version identifier */
  currentVersion: string;
  /** Callback function for version restoration */
  onVersionRestore: (versionId: string) => Promise<void>;
  /** Callback function for version comparison */
  onVersionCompare: (fromVersion: string, toVersion: string) => Promise<any>;
  /** Callback function for modal close */
  onModalClose: () => void;
  /** Translation interface for internationalization */
  translator: ITranslator;
  /** Whether the history viewer is visible */
  isVisible: boolean;
  /** Collaboration provider for session information */
  provider?: YjsNotebookProvider;
}

/**
 * Interface for version timeline item
 */
interface ITimelineItem {
  /** Version metadata */
  version: IVersionMetadata;
  /** Display position in timeline */
  position: number;
  /** Whether this version is currently selected */
  isSelected: boolean;
  /** Whether this version can be reverted to */
  canRevert: boolean;
}

/**
 * Interface for diff comparison result
 */
interface IDiffResult {
  /** Source version identifier */
  fromVersion: string;
  /** Target version identifier */
  toVersion: string;
  /** Diff lines for visualization */
  diffLines: any[];
  /** Summary of changes */
  summary: string;
  /** Number of additions */
  additions: number;
  /** Number of deletions */
  deletions: number;
}

/**
 * HistoryViewer component for viewing version history and managing notebook revisions
 * 
 * Provides comprehensive version history visualization with timeline view, comparison capabilities,
 * and selective reversion functionality for collaborative notebook editing sessions.
 */
export default class HistoryViewer extends ReactWidget {
  private _history: any; // ChangeHistory instance
  private _currentVersion: string;
  private _onVersionRestore: (versionId: string) => Promise<void>;
  private _onVersionCompare: (fromVersion: string, toVersion: string) => Promise<any>;
  private _onModalClose: () => void;
  private _translator: ITranslator;
  private _isVisible: boolean;
  private _provider?: YjsNotebookProvider;

  /**
   * Construct a new HistoryViewer
   * 
   * @param props - Properties for the history viewer component
   */
  constructor(props: IHistoryViewerProps) {
    super();
    this._history = props.history;
    this._currentVersion = props.currentVersion;
    this._onVersionRestore = props.onVersionRestore;
    this._onVersionCompare = props.onVersionCompare;
    this._onModalClose = props.onModalClose;
    this._translator = props.translator;
    this._isVisible = props.isVisible;
    this._provider = props.provider;
    
    this.addClass('jp-HistoryViewer');
    this.id = 'jupyter-notebook-history-viewer';
    this.title.label = this._translator.load('notebook').__('Version History');
    this.title.closable = true;
  }

  /**
   * Get the properties for the history viewer
   */
  get props(): IHistoryViewerProps {
    return {
      history: this._history,
      currentVersion: this._currentVersion,
      onVersionRestore: this._onVersionRestore,
      onVersionCompare: this._onVersionCompare,
      onModalClose: this._onModalClose,
      translator: this._translator,
      isVisible: this._isVisible,
      provider: this._provider
    };
  }

  /**
   * Show the history viewer modal
   */
  showHistory(): void {
    this._isVisible = true;
    this.update();
  }

  /**
   * Hide the history viewer modal
   */
  hideHistory(): void {
    this._isVisible = false;
    this.update();
    this._onModalClose();
  }

  /**
   * Compare two versions
   * 
   * @param fromVersion - Source version identifier
   * @param toVersion - Target version identifier
   */
  async compareVersions(fromVersion: string, toVersion: string): Promise<void> {
    try {
      await this._onVersionCompare(fromVersion, toVersion);
    } catch (error) {
      console.error('Failed to compare versions:', error);
    }
  }

  /**
   * Revert to a specific version
   * 
   * @param versionId - Version identifier to revert to
   */
  async revertToVersion(versionId: string): Promise<void> {
    try {
      await this._onVersionRestore(versionId);
      this.hideHistory();
    } catch (error) {
      console.error('Failed to revert to version:', error);
    }
  }

  /**
   * Navigate to a specific version
   * 
   * @param versionId - Version identifier to navigate to
   */
  navigateToVersion(versionId: string): void {
    this._currentVersion = versionId;
    this.update();
  }

  /**
   * Create a new snapshot
   * 
   * @param description - Optional description for the snapshot
   */
  async createSnapshot(description?: string): Promise<void> {
    try {
      if (this._history && this._history.createSnapshot) {
        await this._history.createSnapshot(description);
        this.update();
      }
    } catch (error) {
      console.error('Failed to create snapshot:', error);
    }
  }

  /**
   * Update the timeline view
   */
  updateTimeline(): void {
    this.update();
  }

  /**
   * Render the history viewer component
   */
  render(): JSX.Element {
    return <HistoryViewerComponent {...this.props} />;
  }
}

/**
 * React functional component for the history viewer interface
 */
const HistoryViewerComponent: React.FC<IHistoryViewerProps> = ({
  history,
  currentVersion,
  onVersionRestore,
  onVersionCompare,
  onModalClose,
  translator,
  isVisible,
  provider
}) => {
  const trans = translator.load('notebook');
  
  // State for version history data
  const [versions, setVersions] = useState<IVersionMetadata[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string>(currentVersion);
  const [compareVersion, setCompareVersion] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<IDiffResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'timeline' | 'comparison'>('timeline');

  // Load version history on mount and when history changes
  useEffect(() => {
    loadVersionHistory();
  }, [history]);

  /**
   * Load version history from the change history system
   */
  const loadVersionHistory = useCallback(async () => {
    if (!history || !history.getVersionHistory) {
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      const versionHistory = await history.getVersionHistory();
      setVersions(versionHistory);
    } catch (err) {
      setError(trans.__('Failed to load version history'));
      console.error('Failed to load version history:', err);
    } finally {
      setLoading(false);
    }
  }, [history, trans]);

  /**
   * Generate timeline items from version history
   */
  const timelineItems = useMemo((): ITimelineItem[] => {
    return versions.map((version, index) => ({
      version,
      position: index,
      isSelected: version.version === selectedVersion,
      canRevert: version.version !== currentVersion
    }));
  }, [versions, selectedVersion, currentVersion]);

  /**
   * Handle version selection
   */
  const handleVersionSelect = useCallback((versionId: string) => {
    setSelectedVersion(versionId);
  }, []);

  /**
   * Handle version comparison
   */
  const handleVersionCompare = useCallback(async (fromVersion: string, toVersion: string) => {
    if (!onVersionCompare) {
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      const result = await onVersionCompare(fromVersion, toVersion);
      
      // Process diff result for visualization
      const diffLines = result.diff ? diffLines(
        result.fromContent || '',
        result.toContent || ''
      ) : [];
      
      const diffResult: IDiffResult = {
        fromVersion,
        toVersion,
        diffLines,
        summary: result.summary || trans.__('No changes detected'),
        additions: diffLines.filter(line => line.added).length,
        deletions: diffLines.filter(line => line.removed).length
      };
      
      setDiffResult(diffResult);
      setCompareVersion(toVersion);
      setViewMode('comparison');
    } catch (err) {
      setError(trans.__('Failed to compare versions'));
      console.error('Failed to compare versions:', err);
    } finally {
      setLoading(false);
    }
  }, [onVersionCompare, trans]);

  /**
   * Handle version revert
   */
  const handleVersionRevert = useCallback(async (versionId: string) => {
    if (!onVersionRestore) {
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      await onVersionRestore(versionId);
      onModalClose();
    } catch (err) {
      setError(trans.__('Failed to revert to version'));
      console.error('Failed to revert to version:', err);
    } finally {
      setLoading(false);
    }
  }, [onVersionRestore, onModalClose, trans]);

  /**
   * Handle close modal
   */
  const handleClose = useCallback(() => {
    onModalClose();
  }, [onModalClose]);

  /**
   * Format version timestamp
   */
  const formatTimestamp = useCallback((timestamp: number): string => {
    try {
      return Time.formatHuman(new Date(timestamp));
    } catch (error) {
      return trans.__('Invalid date');
    }
  }, [trans]);

  /**
   * Get user display name
   */
  const getUserDisplayName = useCallback((userId: string): string => {
    // Try to get user info from provider if available
    if (provider && provider.awareness) {
      const userStates = provider.awareness.getStates();
      for (const [clientId, state] of userStates) {
        if (state.user && state.user.userId === userId) {
          return state.user.displayName || state.user.name || userId;
        }
      }
    }
    return userId;
  }, [provider]);

  /**
   * Get session information
   */
  const getSessionInfo = useCallback(() => {
    if (!provider || !provider.getSessionInfo) {
      return null;
    }
    
    try {
      return provider.getSessionInfo();
    } catch (error) {
      console.error('Failed to get session info:', error);
      return null;
    }
  }, [provider]);

  // Don't render if not visible
  if (!isVisible) {
    return null;
  }

  const sessionInfo = getSessionInfo();

  return (
    <div className="jp-HistoryViewer-modal">
      <div className="jp-HistoryViewer-overlay" onClick={handleClose} />
      <div className="jp-HistoryViewer-content">
        {/* Header */}
        <div className="jp-HistoryViewer-header">
          <h2 className="jp-HistoryViewer-title">
            {trans.__('Version History')}
          </h2>
          <button
            className="jp-HistoryViewer-close"
            onClick={handleClose}
            title={trans.__('Close')}
          >
            <closeIcon.react />
          </button>
        </div>

        {/* Session Info */}
        {sessionInfo && (
          <div className="jp-HistoryViewer-sessionInfo">
            <span className="jp-HistoryViewer-sessionId">
              {trans.__('Session: %1', sessionInfo.sessionId.substring(0, 8))}
            </span>
            <span className="jp-HistoryViewer-connectedUsers">
              {trans.__('Connected Users: %1', sessionInfo.connectedUsers)}
            </span>
          </div>
        )}

        {/* View Mode Toggle */}
        <div className="jp-HistoryViewer-viewModeToggle">
          <button
            className={`jp-HistoryViewer-viewModeButton ${viewMode === 'timeline' ? 'active' : ''}`}
            onClick={() => setViewMode('timeline')}
          >
            {trans.__('Timeline')}
          </button>
          <button
            className={`jp-HistoryViewer-viewModeButton ${viewMode === 'comparison' ? 'active' : ''}`}
            onClick={() => setViewMode('comparison')}
            disabled={!diffResult}
          >
            {trans.__('Comparison')}
          </button>
        </div>

        {/* Error Display */}
        {error && (
          <div className="jp-HistoryViewer-error">
            {error}
          </div>
        )}

        {/* Loading Indicator */}
        {loading && (
          <div className="jp-HistoryViewer-loading">
            {trans.__('Loading...')}
          </div>
        )}

        {/* Timeline View */}
        {viewMode === 'timeline' && (
          <div className="jp-HistoryViewer-timeline">
            {timelineItems.length === 0 ? (
              <div className="jp-HistoryViewer-emptyState">
                {trans.__('No version history available')}
              </div>
            ) : (
              <div className="jp-HistoryViewer-timelineList">
                {timelineItems.map((item) => (
                  <div
                    key={item.version.version}
                    className={`jp-HistoryViewer-timelineItem ${item.isSelected ? 'selected' : ''}`}
                    onClick={() => handleVersionSelect(item.version.version)}
                  >
                    <div className="jp-HistoryViewer-timelineMarker" />
                    <div className="jp-HistoryViewer-timelineContent">
                      <div className="jp-HistoryViewer-timelineHeader">
                        <span className="jp-HistoryViewer-versionId">
                          {item.version.version.substring(0, 8)}...
                        </span>
                        <span className="jp-HistoryViewer-timestamp">
                          {formatTimestamp(item.version.timestamp)}
                        </span>
                      </div>
                      <div className="jp-HistoryViewer-timelineDetails">
                        <div className="jp-HistoryViewer-author">
                          {trans.__('By: %1', getUserDisplayName(item.version.author))}
                        </div>
                        {item.version.description && (
                          <div className="jp-HistoryViewer-description">
                            {item.version.description}
                          </div>
                        )}
                        <div className="jp-HistoryViewer-changes">
                          {trans.__('Changes: %1', item.version.changes.length)}
                        </div>
                      </div>
                      <div className="jp-HistoryViewer-timelineActions">
                        <button
                          className="jp-HistoryViewer-actionButton"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleVersionCompare(currentVersion, item.version.version);
                          }}
                        >
                          {trans.__('Compare')}
                        </button>
                        {item.canRevert && (
                          <button
                            className="jp-HistoryViewer-actionButton primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleVersionRevert(item.version.version);
                            }}
                          >
                            {trans.__('Revert')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Comparison View */}
        {viewMode === 'comparison' && diffResult && (
          <div className="jp-HistoryViewer-comparison">
            <div className="jp-HistoryViewer-comparisonHeader">
              <div className="jp-HistoryViewer-comparisonInfo">
                <span className="jp-HistoryViewer-comparisonVersions">
                  {trans.__('Comparing %1 → %2', diffResult.fromVersion.substring(0, 8), diffResult.toVersion.substring(0, 8))}
                </span>
                <span className="jp-HistoryViewer-comparisonStats">
                  {trans.__('%1 additions, %2 deletions', diffResult.additions, diffResult.deletions)}
                </span>
              </div>
              <button
                className="jp-HistoryViewer-actionButton"
                onClick={() => setViewMode('timeline')}
              >
                {trans.__('Back to Timeline')}
              </button>
            </div>
            
            <div className="jp-HistoryViewer-comparisonSummary">
              {diffResult.summary}
            </div>
            
            <div className="jp-HistoryViewer-diffView">
              {diffResult.diffLines.map((line, index) => (
                <div
                  key={index}
                  className={`jp-HistoryViewer-diffLine ${
                    line.added ? 'added' : line.removed ? 'removed' : ''
                  }`}
                >
                  <span className="jp-HistoryViewer-diffLineNumber">
                    {index + 1}
                  </span>
                  <span className="jp-HistoryViewer-diffLineContent">
                    {line.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Export both the class and the component
export { HistoryViewerComponent };