// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ReactWidget } from '@jupyterlab/apputils';

import { NotebookPanel } from '@jupyterlab/notebook';

import { ITranslator } from '@jupyterlab/translation';

import { INotebookShell } from '@jupyter-notebook/application';

import { YjsNotebookProvider } from '@jupyterlab/yjs';

import React, { useEffect, useState, useCallback, useMemo } from 'react';

import { Widget } from '@lumino/widgets';

/**
 * Interface for history snapshot metadata
 */
interface ISnapshotMetadata {
  /** Unique identifier for the snapshot */
  id: string;
  /** Timestamp when the change occurred */
  timestamp: Date;
  /** User who made the change */
  user: {
    id: string;
    name: string;
    avatar?: string;
  };
  /** Type of change made */
  changeType: 'cell-added' | 'cell-modified' | 'cell-deleted' | 'cell-moved' | 'output-changed' | 'metadata-changed';
  /** Description of the change */
  description: string;
  /** Cell index affected by the change */
  cellIndex?: number;
  /** Optional commit message if provided */
  message?: string;
  /** Kernel state when change occurred */
  kernelState?: 'idle' | 'busy' | 'unknown';
  /** Session duration at time of change */
  sessionDuration?: number;
}

/**
 * Interface for diff comparison data
 */
interface IDiffData {
  /** Before state of the content */
  before: string;
  /** After state of the content */
  after: string;
  /** Type of content being compared */
  contentType: 'code' | 'markdown' | 'raw' | 'output' | 'metadata';
  /** Cell index for the diff */
  cellIndex: number;
}

/**
 * Interface for filter options
 */
interface IFilterOptions {
  /** Filter by specific user */
  userId?: string;
  /** Filter by time range */
  startTime?: Date;
  endTime?: Date;
  /** Filter by change types */
  changeTypes?: string[];
  /** Search text in descriptions */
  searchText?: string;
}

/**
 * Props interface for the HistoryViewer component
 */
interface IHistoryViewerProps {
  /** The notebook shell for UI integration */
  shell: INotebookShell;
  /** Yjs provider for real-time collaboration */
  yjsProvider: YjsNotebookProvider;
  /** The notebook panel instance */
  notebookPanel: NotebookPanel;
  /** Translation service */
  translator: ITranslator;
}

/**
 * React component for viewing and navigating change history with timeline visualization,
 * diff comparisons, and version restoration capabilities.
 */
const HistoryViewer = ({
  shell,
  yjsProvider,
  notebookPanel,
  translator,
}: IHistoryViewerProps): JSX.Element => {
  const trans = translator.load('notebook');
  
  // State management for history data and UI
  const [snapshots, setSnapshots] = useState<ISnapshotMetadata[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<ISnapshotMetadata | null>(null);
  const [compareSnapshot, setCompareSnapshot] = useState<ISnapshotMetadata | null>(null);
  const [diffData, setDiffData] = useState<IDiffData | null>(null);
  const [viewMode, setViewMode] = useState<'timeline' | 'diff' | 'restore'>('timeline');
  const [diffViewType, setDiffViewType] = useState<'side-by-side' | 'unified'>('side-by-side');
  const [filters, setFilters] = useState<IFilterOptions>({});
  const [isLoading, setIsLoading] = useState(false);
  const [users, setUsers] = useState<Array<{ id: string; name: string; avatar?: string }>>([]);

  // Filtered snapshots based on current filter options
  const filteredSnapshots = useMemo(() => {
    return snapshots.filter(snapshot => {
      // Filter by user
      if (filters.userId && snapshot.user.id !== filters.userId) {
        return false;
      }
      
      // Filter by time range
      if (filters.startTime && snapshot.timestamp < filters.startTime) {
        return false;
      }
      if (filters.endTime && snapshot.timestamp > filters.endTime) {
        return false;
      }
      
      // Filter by change types
      if (filters.changeTypes && filters.changeTypes.length > 0 && 
          !filters.changeTypes.includes(snapshot.changeType)) {
        return false;
      }
      
      // Filter by search text
      if (filters.searchText && 
          !snapshot.description.toLowerCase().includes(filters.searchText.toLowerCase()) &&
          !snapshot.message?.toLowerCase().includes(filters.searchText.toLowerCase())) {
        return false;
      }
      
      return true;
    });
  }, [snapshots, filters]);

  // Load history snapshots from the Yjs provider
  const loadSnapshots = useCallback(async () => {
    try {
      setIsLoading(true);
      
      // Get the shared document from Yjs provider
      const sharedDoc = yjsProvider.sharedDocument;
      if (!sharedDoc) {
        return;
      }

      // Get history from the history module 
      // In a real implementation, this would interface with the history.ts module
      const historySnapshots: ISnapshotMetadata[] = [
        {
          id: 'snapshot-1',
          timestamp: new Date(Date.now() - 3600000), // 1 hour ago
          user: { id: 'user1', name: 'Alice Smith', avatar: '👤' },
          changeType: 'cell-added',
          description: 'Added new code cell with data analysis',
          cellIndex: 0,
          message: 'Initial data exploration',
          kernelState: 'idle',
          sessionDuration: 300
        },
        {
          id: 'snapshot-2',
          timestamp: new Date(Date.now() - 1800000), // 30 minutes ago
          user: { id: 'user2', name: 'Bob Johnson', avatar: '👨‍💻' },
          changeType: 'cell-modified',
          description: 'Modified visualization code in cell 2',
          cellIndex: 1,
          kernelState: 'busy',
          sessionDuration: 1800
        },
        {
          id: 'snapshot-3',
          timestamp: new Date(Date.now() - 900000), // 15 minutes ago
          user: { id: 'user1', name: 'Alice Smith', avatar: '👤' },
          changeType: 'output-changed',
          description: 'Cell output updated after execution',
          cellIndex: 1,
          kernelState: 'idle',
          sessionDuration: 2700
        }
      ];

      setSnapshots(historySnapshots);
      
      // Extract unique users for filter dropdown
      const uniqueUsers = Array.from(new Set(historySnapshots.map(s => s.user.id)))
        .map(id => historySnapshots.find(s => s.user.id === id)!.user);
      setUsers(uniqueUsers);
      
    } catch (error) {
      console.error('Failed to load history snapshots:', error);
    } finally {
      setIsLoading(false);
    }
  }, [yjsProvider]);

  // Generate diff data for comparison between two snapshots
  const generateDiff = useCallback((snapshot1: ISnapshotMetadata, snapshot2: ISnapshotMetadata) => {
    // In a real implementation, this would generate actual diffs from the history module
    const mockDiff: IDiffData = {
      before: `# Data Analysis
import pandas as pd
import numpy as np

# Load data
data = pd.read_csv('data.csv')`,
      after: `# Data Analysis
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

# Load data
data = pd.read_csv('data.csv')
print(f"Dataset shape: {data.shape}")`,
      contentType: 'code',
      cellIndex: snapshot2.cellIndex || 0
    };
    
    setDiffData(mockDiff);
  }, []);

  // Handle snapshot selection for viewing details
  const handleSnapshotSelect = useCallback((snapshot: ISnapshotMetadata) => {
    setSelectedSnapshot(snapshot);
    setViewMode('timeline');
  }, []);

  // Handle comparison between two snapshots
  const handleCompareSnapshots = useCallback((snapshot1: ISnapshotMetadata, snapshot2: ISnapshotMetadata) => {
    setSelectedSnapshot(snapshot1);
    setCompareSnapshot(snapshot2);
    generateDiff(snapshot1, snapshot2);
    setViewMode('diff');
  }, [generateDiff]);

  // Handle version restoration
  const handleRestoreVersion = useCallback(async (snapshot: ISnapshotMetadata, cellIndices?: number[]) => {
    try {
      setIsLoading(true);
      
      // In a real implementation, this would restore from the history module
      console.log(`Restoring version ${snapshot.id}`, cellIndices ? `for cells ${cellIndices.join(', ')}` : 'for entire notebook');
      
      // Mock restoration logic
      if (cellIndices) {
        // Selective cell restoration
        for (const cellIndex of cellIndices) {
          // Restore specific cell content from snapshot
          console.log(`Restoring cell ${cellIndex} to state from ${snapshot.timestamp}`);
        }
      } else {
        // Full notebook restoration
        console.log(`Restoring entire notebook to state from ${snapshot.timestamp}`);
      }
      
      // Refresh snapshots after restoration
      await loadSnapshots();
      
    } catch (error) {
      console.error('Failed to restore version:', error);
    } finally {
      setIsLoading(false);
    }
  }, [loadSnapshots]);

  // Handle filter changes
  const handleFilterChange = useCallback((newFilters: Partial<IFilterOptions>) => {
    setFilters(prev => ({ ...prev, ...newFilters }));
  }, []);

  // Subscribe to document update events for real-time history tracking
  useEffect(() => {
    const handleDocumentUpdate = () => {
      // Reload snapshots when document updates
      loadSnapshots();
    };

    // Subscribe to Yjs document changes
    const sharedDoc = yjsProvider.sharedDocument;
    if (sharedDoc) {
      sharedDoc.on('update', handleDocumentUpdate);
      
      return () => {
        sharedDoc.off('update', handleDocumentUpdate);
      };
    }
  }, [yjsProvider, loadSnapshots]);

  // Initial load of snapshots
  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

  // Render timeline view
  const renderTimelineView = () => (
    <div className="jp-Collab-HistoryTimeline">
      <div className="jp-Collab-HistoryFilters">
        <div className="jp-Collab-FilterRow">
          <select 
            value={filters.userId || ''} 
            onChange={(e) => handleFilterChange({ userId: e.target.value || undefined })}
            className="jp-Collab-FilterSelect"
          >
            <option value="">{trans.__('All Users')}</option>
            {users.map(user => (
              <option key={user.id} value={user.id}>{user.name}</option>
            ))}
          </select>
          
          <select 
            value={filters.changeTypes?.join(',') || ''} 
            onChange={(e) => handleFilterChange({ 
              changeTypes: e.target.value ? e.target.value.split(',') : undefined 
            })}
            className="jp-Collab-FilterSelect"
          >
            <option value="">{trans.__('All Change Types')}</option>
            <option value="cell-added">{trans.__('Cell Added')}</option>
            <option value="cell-modified">{trans.__('Cell Modified')}</option>
            <option value="cell-deleted">{trans.__('Cell Deleted')}</option>
            <option value="cell-moved">{trans.__('Cell Moved')}</option>
            <option value="output-changed">{trans.__('Output Changed')}</option>
            <option value="metadata-changed">{trans.__('Metadata Changed')}</option>
          </select>
        </div>
        
        <div className="jp-Collab-FilterRow">
          <input
            type="text"
            placeholder={trans.__('Search descriptions...')}
            value={filters.searchText || ''}
            onChange={(e) => handleFilterChange({ searchText: e.target.value || undefined })}
            className="jp-Collab-FilterInput"
          />
        </div>
      </div>

      <div className="jp-Collab-HistoryList">
        {filteredSnapshots.map((snapshot, index) => (
          <div 
            key={snapshot.id} 
            className={`jp-Collab-HistoryItem ${selectedSnapshot?.id === snapshot.id ? 'jp-mod-selected' : ''}`}
            onClick={() => handleSnapshotSelect(snapshot)}
          >
            <div className="jp-Collab-HistoryItemHeader">
              <div className="jp-Collab-UserInfo">
                <span className="jp-Collab-UserAvatar">{snapshot.user.avatar || '👤'}</span>
                <span className="jp-Collab-UserName">{snapshot.user.name}</span>
              </div>
              <div className="jp-Collab-Timestamp">
                {snapshot.timestamp.toLocaleString()}
              </div>
            </div>
            
            <div className="jp-Collab-ChangeInfo">
              <span className={`jp-Collab-ChangeType jp-Collab-ChangeType-${snapshot.changeType}`}>
                {snapshot.changeType.replace('-', ' ')}
              </span>
              {snapshot.cellIndex !== undefined && (
                <span className="jp-Collab-CellIndex">Cell {snapshot.cellIndex + 1}</span>
              )}
            </div>
            
            <div className="jp-Collab-Description">{snapshot.description}</div>
            
            {snapshot.message && (
              <div className="jp-Collab-Message">{snapshot.message}</div>
            )}

            <div className="jp-Collab-HistoryActions">
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  if (index < filteredSnapshots.length - 1) {
                    handleCompareSnapshots(filteredSnapshots[index + 1], snapshot);
                  }
                }}
                disabled={index >= filteredSnapshots.length - 1}
                className="jp-Collab-ActionButton"
              >
                {trans.__('Compare')}
              </button>
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  handleRestoreVersion(snapshot);
                }}
                className="jp-Collab-ActionButton jp-Collab-RestoreButton"
              >
                {trans.__('Restore')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // Render diff comparison view
  const renderDiffView = () => (
    <div className="jp-Collab-HistoryDiff">
      <div className="jp-Collab-DiffHeader">
        <div className="jp-Collab-DiffInfo">
          <h3>{trans.__('Comparing Versions')}</h3>
          <div className="jp-Collab-DiffVersions">
            <div className="jp-Collab-DiffVersion">
              <span className="jp-Collab-VersionLabel">{trans.__('Before')}: </span>
              <span className="jp-Collab-VersionInfo">{selectedSnapshot?.timestamp.toLocaleString()}</span>
            </div>
            <div className="jp-Collab-DiffVersion">
              <span className="jp-Collab-VersionLabel">{trans.__('After')}: </span>
              <span className="jp-Collab-VersionInfo">{compareSnapshot?.timestamp.toLocaleString()}</span>
            </div>
          </div>
        </div>
        
        <div className="jp-Collab-DiffControls">
          <button 
            onClick={() => setViewMode('timeline')}
            className="jp-Collab-ActionButton"
          >
            {trans.__('Back to Timeline')}
          </button>
          <select 
            value={diffViewType} 
            onChange={(e) => setDiffViewType(e.target.value as 'side-by-side' | 'unified')}
            className="jp-Collab-ViewTypeSelect"
          >
            <option value="side-by-side">{trans.__('Side by Side')}</option>
            <option value="unified">{trans.__('Unified')}</option>
          </select>
        </div>
      </div>

      {diffData && (
        <div className={`jp-Collab-DiffContent jp-Collab-DiffContent-${diffViewType}`}>
          {diffViewType === 'side-by-side' ? (
            <div className="jp-Collab-DiffSideBySide">
              <div className="jp-Collab-DiffPanel jp-Collab-DiffPanel-before">
                <div className="jp-Collab-DiffPanelHeader">{trans.__('Before')}</div>
                <pre className="jp-Collab-DiffCode">{diffData.before}</pre>
              </div>
              <div className="jp-Collab-DiffPanel jp-Collab-DiffPanel-after">
                <div className="jp-Collab-DiffPanelHeader">{trans.__('After')}</div>
                <pre className="jp-Collab-DiffCode">{diffData.after}</pre>
              </div>
            </div>
          ) : (
            <div className="jp-Collab-DiffUnified">
              <pre className="jp-Collab-DiffCode">
                {/* Simplified unified diff display */}
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-context">--- Before</div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-context">+++ After</div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-removed">-import pandas as pd</div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-removed">-import numpy as np</div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-added">+import pandas as pd</div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-added">+import numpy as np</div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-added">+import matplotlib.pyplot as plt</div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-context"> </div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-context"># Load data</div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-context">data = pd.read_csv('data.csv')</div>
                <div className="jp-Collab-DiffLine jp-Collab-DiffLine-added">+print(f"Dataset shape: {data.shape}")</div>
              </pre>
            </div>
          )}
          
          <div className="jp-Collab-DiffActions">
            <button 
              onClick={() => selectedSnapshot && handleRestoreVersion(selectedSnapshot, [diffData.cellIndex])}
              className="jp-Collab-ActionButton jp-Collab-RestoreButton"
            >
              {trans.__('Restore This Cell')}
            </button>
            <button 
              onClick={() => compareSnapshot && handleRestoreVersion(compareSnapshot)}
              className="jp-Collab-ActionButton jp-Collab-RestoreButton"
            >
              {trans.__('Restore Full Version')}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // Main render
  return (
    <div className="jp-Collab-HistoryViewer">
      <div className="jp-Collab-HistoryHeader">
        <h2 className="jp-Collab-HistoryTitle">{trans.__('History')}</h2>
        <div className="jp-Collab-HistoryControls">
          <button 
            onClick={loadSnapshots}
            disabled={isLoading}
            className="jp-Collab-RefreshButton"
            title={trans.__('Refresh History')}
          >
            🔄
          </button>
        </div>
      </div>

      <div className="jp-Collab-HistoryContent">
        {isLoading ? (
          <div className="jp-Collab-Loading">{trans.__('Loading history...')}</div>
        ) : (
          <>
            {viewMode === 'timeline' && renderTimelineView()}
            {viewMode === 'diff' && renderDiffView()}
          </>
        )}
      </div>

      {filteredSnapshots.length === 0 && !isLoading && (
        <div className="jp-Collab-EmptyState">
          <div className="jp-Collab-EmptyStateIcon">📜</div>
          <div className="jp-Collab-EmptyStateText">
            {trans.__('No history entries found')}
          </div>
          <div className="jp-Collab-EmptyStateSubtext">
            {trans.__('Changes will appear here as you and your collaborators edit the notebook')}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * A namespace for HistoryViewerComponent static methods.
 */
export namespace HistoryViewerComponent {
  /**
   * Create a new HistoryViewer widget
   *
   * @param options The component options
   */
  export const create = (options: IHistoryViewerProps): ReactWidget => {
    return ReactWidget.create(<HistoryViewer {...options} />);
  };
}

/**
 * HistoryViewerComponent class for integration with the notebook extension system.
 * Provides timeline visualization, diff comparisons, and version restoration capabilities
 * for collaborative notebook editing sessions.
 */
export class HistoryViewerComponent extends Widget {
  constructor(options: IHistoryViewerProps) {
    super();
    
    this._options = options;
    this.addClass('jp-Collab-HistoryViewerWidget');
    this.title.label = options.translator.load('notebook').__('History');
    this.title.caption = options.translator.load('notebook').__('View and navigate notebook change history');
    
    // Create the React widget and add it as a child
    this._widget = HistoryViewerComponent.create(options);
    this.addWidget(this._widget);
    
    // Set up responsive behavior
    this._updateLayout();
  }

  /**
   * Handle resize events
   */
  protected onResize(): void {
    super.onResize();
    this._updateLayout();
  }

  /**
   * Update layout based on available space
   */
  private _updateLayout(): void {
    const width = this.node.clientWidth;
    
    // Adapt layout for different screen sizes
    if (width < 300) {
      this.addClass('jp-Collab-HistoryViewer-compact');
    } else {
      this.removeClass('jp-Collab-HistoryViewer-compact');
    }
  }

  /**
   * Dispose of the widget
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    
    this._widget.dispose();
    super.dispose();
  }

  private _options: IHistoryViewerProps;
  private _widget: ReactWidget;
}