/**
 * History viewer component for collaborative notebooks
 *
 * This component provides a timeline interface to browse previous versions of the notebook,
 * compare changes between versions with visual diff highlighting, and selectively restore
 * content from earlier versions.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { NotebookPanel } from '@jupyterlab/notebook';
import { IHistoryManager, IDocumentSnapshot, IDocumentDiff } from '@jupyterlab/notebook/lib/collab/history';

/**
 * Props for the HistoryViewer component
 */
interface IHistoryViewerProps {
  /**
   * The notebook panel containing the notebook to view history for
   */
  notebookPanel: NotebookPanel;

  /**
   * The history manager service
   */
  historyManager: IHistoryManager;

  /**
   * The translator service
   */
  translator?: ITranslator;
}

/**
 * Props for the VersionTimeline component
 */
interface IVersionTimelineProps {
  /**
   * List of snapshots to display in the timeline
   */
  snapshots: IDocumentSnapshot[];

  /**
   * Currently selected snapshot ID
   */
  selectedId: string | null;

  /**
   * Comparison snapshot ID
   */
  comparisonId: string | null;

  /**
   * Handler for when a snapshot is selected
   */
  onSelectSnapshot: (id: string) => void;

  /**
   * Handler for when a comparison snapshot is selected
   */
  onSelectComparison: (id: string) => void;

  /**
   * The translator service
   */
  translator: ITranslator;
}

/**
 * Props for the DiffView component
 */
interface IDiffViewProps {
  /**
   * The diff to display
   */
  diff: IDocumentDiff | null;

  /**
   * Whether to show the diff in split view
   */
  splitView: boolean;

  /**
   * Handler for toggling split view
   */
  onToggleSplitView: () => void;

  /**
   * The source snapshot
   */
  sourceSnapshot: IDocumentSnapshot | null;

  /**
   * The target snapshot
   */
  targetSnapshot: IDocumentSnapshot | null;

  /**
   * The translator service
   */
  translator: ITranslator;
}

/**
 * Props for the RestoreControls component
 */
interface IRestoreControlsProps {
  /**
   * The selected snapshot to restore from
   */
  selectedSnapshot: IDocumentSnapshot | null;

  /**
   * Handler for restoring the entire notebook
   */
  onRestoreNotebook: () => void;

  /**
   * Handler for restoring selected cells
   */
  onRestoreSelectedCells: () => void;

  /**
   * Whether any cells are currently selected
   */
  hasCellSelection: boolean;

  /**
   * The translator service
   */
  translator: ITranslator;
}

/**
 * A component that displays a timeline of notebook versions
 */
const VersionTimeline: React.FC<IVersionTimelineProps> = ({
  snapshots,
  selectedId,
  comparisonId,
  onSelectSnapshot,
  onSelectComparison,
  translator
}) => {
  const trans = translator.load('notebook');

  // Group snapshots by date
  const groupedSnapshots = useMemo(() => {
    const groups: { [key: string]: IDocumentSnapshot[] } = {};
    
    snapshots.forEach(snapshot => {
      const date = new Date(snapshot.timestamp);
      const dateKey = date.toLocaleDateString();
      
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      
      groups[dateKey].push(snapshot);
    });
    
    // Sort snapshots within each group by timestamp (newest first)
    Object.keys(groups).forEach(key => {
      groups[key].sort((a, b) => b.timestamp - a.timestamp);
    });
    
    return groups;
  }, [snapshots]);

  // Sort date keys (newest first)
  const sortedDates = useMemo(() => {
    return Object.keys(groupedSnapshots).sort((a, b) => {
      const dateA = new Date(a).getTime();
      const dateB = new Date(b).getTime();
      return dateB - dateA;
    });
  }, [groupedSnapshots]);

  return (
    <div className="jp-HistoryViewer-timeline">
      <h3 className="jp-HistoryViewer-timelineHeader">
        {trans.__('Version History')}
      </h3>
      
      {sortedDates.map(dateKey => (
        <div key={dateKey} className="jp-HistoryViewer-timelineGroup">
          <div className="jp-HistoryViewer-timelineDate">{dateKey}</div>
          
          {groupedSnapshots[dateKey].map(snapshot => {
            const isSelected = snapshot.id === selectedId;
            const isComparison = snapshot.id === comparisonId;
            const time = new Date(snapshot.timestamp).toLocaleTimeString();
            const isMajor = snapshot.isMajorVersion;
            
            return (
              <div 
                key={snapshot.id} 
                className={`jp-HistoryViewer-timelineItem ${
                  isSelected ? 'jp-HistoryViewer-timelineItem-selected' : ''
                } ${
                  isComparison ? 'jp-HistoryViewer-timelineItem-comparison' : ''
                } ${
                  isMajor ? 'jp-HistoryViewer-timelineItem-major' : ''
                }`}
              >
                <div className="jp-HistoryViewer-timelineItemContent">
                  <div className="jp-HistoryViewer-timelineItemTime">{time}</div>
                  <div className="jp-HistoryViewer-timelineItemTitle">
                    {snapshot.description || `Version ${snapshot.version}`}
                  </div>
                  <div className="jp-HistoryViewer-timelineItemAuthor">
                    {snapshot.author.name}
                  </div>
                </div>
                
                <div className="jp-HistoryViewer-timelineItemActions">
                  <button 
                    className="jp-HistoryViewer-timelineItemButton"
                    onClick={() => onSelectSnapshot(snapshot.id)}
                    title={trans.__('View this version')}
                  >
                    {isSelected ? trans.__('Selected') : trans.__('Select')}
                  </button>
                  
                  {selectedId && selectedId !== snapshot.id && (
                    <button 
                      className="jp-HistoryViewer-timelineItemButton"
                      onClick={() => onSelectComparison(snapshot.id)}
                      title={trans.__('Compare with selected version')}
                    >
                      {isComparison ? trans.__('Comparing') : trans.__('Compare')}
                    </button>
                  )}
                </div>
                
                {snapshot.tags && snapshot.tags.length > 0 && (
                  <div className="jp-HistoryViewer-timelineItemTags">
                    {snapshot.tags.map(tag => (
                      <span key={tag} className="jp-HistoryViewer-timelineItemTag">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      
      {snapshots.length === 0 && (
        <div className="jp-HistoryViewer-timelineEmpty">
          {trans.__('No version history available')}
        </div>
      )}
    </div>
  );
};

/**
 * A component that displays a diff between two notebook versions
 */
const DiffView: React.FC<IDiffViewProps> = ({
  diff,
  splitView,
  onToggleSplitView,
  sourceSnapshot,
  targetSnapshot,
  translator
}) => {
  const trans = translator.load('notebook');

  if (!diff || !sourceSnapshot || !targetSnapshot) {
    return (
      <div className="jp-HistoryViewer-diffEmpty">
        {trans.__('Select two versions to compare')}
      </div>
    );
  }

  const sourceDate = new Date(sourceSnapshot.timestamp).toLocaleString();
  const targetDate = new Date(targetSnapshot.timestamp).toLocaleString();

  return (
    <div className="jp-HistoryViewer-diff">
      <div className="jp-HistoryViewer-diffHeader">
        <div className="jp-HistoryViewer-diffTitle">
          {trans.__('Comparing versions')}
        </div>
        
        <div className="jp-HistoryViewer-diffControls">
          <label className="jp-HistoryViewer-diffViewToggle">
            <input 
              type="checkbox" 
              checked={splitView} 
              onChange={onToggleSplitView} 
            />
            {trans.__('Split View')}
          </label>
        </div>
      </div>
      
      <div className="jp-HistoryViewer-diffInfo">
        <div className="jp-HistoryViewer-diffInfoItem">
          <span className="jp-HistoryViewer-diffInfoLabel">
            {trans.__('From:')}
          </span>
          <span className="jp-HistoryViewer-diffInfoValue">
            {sourceSnapshot.description || `Version ${sourceSnapshot.version}`} ({sourceDate})
          </span>
        </div>
        
        <div className="jp-HistoryViewer-diffInfoItem">
          <span className="jp-HistoryViewer-diffInfoLabel">
            {trans.__('To:')}
          </span>
          <span className="jp-HistoryViewer-diffInfoValue">
            {targetSnapshot.description || `Version ${targetSnapshot.version}`} ({targetDate})
          </span>
        </div>
      </div>
      
      <div className="jp-HistoryViewer-diffSummary">
        <div className="jp-HistoryViewer-diffSummaryItem">
          <span className="jp-HistoryViewer-diffSummaryLabel">
            {trans.__('Cells Added:')}
          </span>
          <span className="jp-HistoryViewer-diffSummaryValue jp-HistoryViewer-diffSummaryAdded">
            {diff.summary.cellsAdded}
          </span>
        </div>
        
        <div className="jp-HistoryViewer-diffSummaryItem">
          <span className="jp-HistoryViewer-diffSummaryLabel">
            {trans.__('Cells Removed:')}
          </span>
          <span className="jp-HistoryViewer-diffSummaryValue jp-HistoryViewer-diffSummaryRemoved">
            {diff.summary.cellsRemoved}
          </span>
        </div>
        
        <div className="jp-HistoryViewer-diffSummaryItem">
          <span className="jp-HistoryViewer-diffSummaryLabel">
            {trans.__('Cells Modified:')}
          </span>
          <span className="jp-HistoryViewer-diffSummaryValue jp-HistoryViewer-diffSummaryModified">
            {diff.summary.cellsModified}
          </span>
        </div>
      </div>
      
      <div className={`jp-HistoryViewer-diffContent ${
        splitView ? 'jp-HistoryViewer-diffContent-split' : 'jp-HistoryViewer-diffContent-unified'
      }`}>
        {Object.keys(diff.cellChanges).map(cellId => {
          const cellChange = diff.cellChanges[cellId];
          
          return (
            <div 
              key={cellId} 
              className={`jp-HistoryViewer-diffCell jp-HistoryViewer-diffCell-${cellChange.type}`}
              data-cell-id={cellId}
            >
              <div className="jp-HistoryViewer-diffCellHeader">
                <div className="jp-HistoryViewer-diffCellType">
                  {cellChange.type === 'added' && (
                    <span className="jp-HistoryViewer-diffCellAdded">
                      {trans.__('Added')}
                    </span>
                  )}
                  {cellChange.type === 'removed' && (
                    <span className="jp-HistoryViewer-diffCellRemoved">
                      {trans.__('Removed')}
                    </span>
                  )}
                  {cellChange.type === 'modified' && (
                    <span className="jp-HistoryViewer-diffCellModified">
                      {trans.__('Modified')}
                    </span>
                  )}
                  {cellChange.type === 'unchanged' && (
                    <span className="jp-HistoryViewer-diffCellUnchanged">
                      {trans.__('Unchanged')}
                    </span>
                  )}
                </div>
                <div className="jp-HistoryViewer-diffCellId">
                  {trans.__('Cell ID: %1', cellId)}
                </div>
              </div>
              
              {cellChange.type === 'modified' && cellChange.contentChanges && (
                <div className="jp-HistoryViewer-diffCellContent">
                  {splitView ? (
                    <div className="jp-HistoryViewer-diffCellSplit">
                      <div className="jp-HistoryViewer-diffCellOld">
                        <div className="jp-HistoryViewer-diffCellLabel">
                          {trans.__('Previous')}
                        </div>
                        <pre className="jp-HistoryViewer-diffCellCode">
                          {cellChange.contentChanges[0].oldContent || ''}
                        </pre>
                      </div>
                      <div className="jp-HistoryViewer-diffCellNew">
                        <div className="jp-HistoryViewer-diffCellLabel">
                          {trans.__('Current')}
                        </div>
                        <pre className="jp-HistoryViewer-diffCellCode">
                          {cellChange.contentChanges[0].newContent || ''}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div className="jp-HistoryViewer-diffCellUnified">
                      <pre className="jp-HistoryViewer-diffCellCode">
                        {/* In a real implementation, this would show a unified diff view */}
                        {trans.__('Unified diff view')}
                      </pre>
                    </div>
                  )}
                </div>
              )}
              
              {(cellChange.type === 'added' || cellChange.type === 'removed') && (
                <div className="jp-HistoryViewer-diffCellContent">
                  <pre className="jp-HistoryViewer-diffCellCode">
                    {/* In a real implementation, this would show the cell content */}
                    {cellChange.type === 'added' ? 
                      trans.__('New cell content') : 
                      trans.__('Removed cell content')}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * A component that provides controls for restoring content from a snapshot
 */
const RestoreControls: React.FC<IRestoreControlsProps> = ({
  selectedSnapshot,
  onRestoreNotebook,
  onRestoreSelectedCells,
  hasCellSelection,
  translator
}) => {
  const trans = translator.load('notebook');

  if (!selectedSnapshot) {
    return null;
  }

  return (
    <div className="jp-HistoryViewer-restore">
      <div className="jp-HistoryViewer-restoreHeader">
        {trans.__('Restore Content')}
      </div>
      
      <div className="jp-HistoryViewer-restoreWarning">
        {trans.__('Restoring content will overwrite current changes. This cannot be undone.')}
      </div>
      
      <div className="jp-HistoryViewer-restoreActions">
        <button 
          className="jp-HistoryViewer-restoreButton jp-HistoryViewer-restoreNotebookButton"
          onClick={onRestoreNotebook}
          title={trans.__('Restore the entire notebook to this version')}
        >
          {trans.__('Restore Entire Notebook')}
        </button>
        
        <button 
          className="jp-HistoryViewer-restoreButton jp-HistoryViewer-restoreCellsButton"
          onClick={onRestoreSelectedCells}
          disabled={!hasCellSelection}
          title={hasCellSelection ? 
            trans.__('Restore only the selected cells from this version') : 
            trans.__('Select cells in the notebook to restore')}
        >
          {trans.__('Restore Selected Cells')}
        </button>
      </div>
    </div>
  );
};

/**
 * A component that displays the version history of a notebook
 */
export const HistoryViewer: React.FC<IHistoryViewerProps> = ({
  notebookPanel,
  historyManager,
  translator = nullTranslator
}) => {
  const trans = translator.load('notebook');
  
  // State for snapshots and selection
  const [snapshots, setSnapshots] = useState<IDocumentSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<IDocumentSnapshot | null>(null);
  const [comparisonSnapshot, setComparisonSnapshot] = useState<IDocumentSnapshot | null>(null);
  const [diff, setDiff] = useState<IDocumentDiff | null>(null);
  const [splitView, setSplitView] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [hasCellSelection, setHasCellSelection] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterTags, setFilterTags] = useState<string[]>([]);
  
  // Load snapshots on component mount
  useEffect(() => {
    const loadSnapshots = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const history = await historyManager.getHistory();
        setSnapshots(history);
        
        // Select the most recent snapshot by default
        if (history.length > 0) {
          setSelectedId(history[0].id);
          setSelectedSnapshot(history[0]);
        }
      } catch (err) {
        console.error('Failed to load history:', err);
        setError(trans.__('Failed to load version history'));
      } finally {
        setLoading(false);
      }
    };
    
    loadSnapshots();
    
    // Subscribe to snapshot creation events
    const onSnapshotCreated = (sender: any, snapshot: IDocumentSnapshot) => {
      setSnapshots(prev => [snapshot, ...prev]);
    };
    
    historyManager.snapshotCreated.connect(onSnapshotCreated);
    
    return () => {
      historyManager.snapshotCreated.disconnect(onSnapshotCreated);
    };
  }, [historyManager, trans]);
  
  // Update cell selection state when active cell changes
  useEffect(() => {
    const notebook = notebookPanel.content;
    
    const updateSelectionState = () => {
      setHasCellSelection(notebook.selectedCells.length > 0);
    };
    
    notebook.selectionChanged.connect(updateSelectionState);
    updateSelectionState();
    
    return () => {
      notebook.selectionChanged.disconnect(updateSelectionState);
    };
  }, [notebookPanel]);
  
  // Update comparison when selected snapshots change
  useEffect(() => {
    const updateComparison = async () => {
      if (selectedId && comparisonId) {
        try {
          setLoading(true);
          const diffResult = await historyManager.getDiff(comparisonId, selectedId);
          setDiff(diffResult);
        } catch (err) {
          console.error('Failed to get diff:', err);
          setError(trans.__('Failed to compare versions'));
        } finally {
          setLoading(false);
        }
      } else {
        setDiff(null);
      }
    };
    
    updateComparison();
  }, [selectedId, comparisonId, historyManager, trans]);
  
  // Handle snapshot selection
  const handleSelectSnapshot = useCallback(async (id: string) => {
    try {
      const snapshot = await historyManager.getSnapshot(id);
      if (snapshot) {
        setSelectedId(id);
        setSelectedSnapshot(snapshot);
        
        // If this was the comparison snapshot, clear the comparison
        if (id === comparisonId) {
          setComparisonId(null);
          setComparisonSnapshot(null);
        }
      }
    } catch (err) {
      console.error('Failed to select snapshot:', err);
      setError(trans.__('Failed to select version'));
    }
  }, [historyManager, comparisonId, trans]);
  
  // Handle comparison selection
  const handleSelectComparison = useCallback(async (id: string) => {
    try {
      const snapshot = await historyManager.getSnapshot(id);
      if (snapshot) {
        setComparisonId(id);
        setComparisonSnapshot(snapshot);
      }
    } catch (err) {
      console.error('Failed to select comparison:', err);
      setError(trans.__('Failed to select comparison version'));
    }
  }, [historyManager, trans]);
  
  // Handle restore notebook
  const handleRestoreNotebook = useCallback(async () => {
    if (!selectedSnapshot) {
      return;
    }
    
    try {
      await historyManager.restoreSnapshot(selectedSnapshot.id, {
        createSnapshot: true,
        snapshotDescription: trans.__('Restored from version %1', selectedSnapshot.version)
      });
    } catch (err) {
      console.error('Failed to restore notebook:', err);
      setError(trans.__('Failed to restore notebook'));
    }
  }, [selectedSnapshot, historyManager, trans]);
  
  // Handle restore selected cells
  const handleRestoreSelectedCells = useCallback(async () => {
    if (!selectedSnapshot || !hasCellSelection) {
      return;
    }
    
    try {
      const notebook = notebookPanel.content;
      const selectedCellIds = notebook.selectedCells.map(cell => cell.model.id);
      
      await historyManager.restoreCells(selectedSnapshot.id, selectedCellIds, {
        createSnapshot: true,
        snapshotDescription: trans.__('Restored cells from version %1', selectedSnapshot.version)
      });
    } catch (err) {
      console.error('Failed to restore cells:', err);
      setError(trans.__('Failed to restore selected cells'));
    }
  }, [selectedSnapshot, hasCellSelection, notebookPanel, historyManager, trans]);
  
  // Filter snapshots based on search query and tags
  const filteredSnapshots = useMemo(() => {
    return snapshots.filter(snapshot => {
      // Filter by search query
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const description = (snapshot.description || '').toLowerCase();
        const authorName = snapshot.author.name.toLowerCase();
        const version = snapshot.version.toString();
        
        if (!description.includes(query) && 
            !authorName.includes(query) && 
            !version.includes(query)) {
          return false;
        }
      }
      
      // Filter by tags
      if (filterTags.length > 0) {
        if (!snapshot.tags || !filterTags.some(tag => snapshot.tags!.includes(tag))) {
          return false;
        }
      }
      
      return true;
    });
  }, [snapshots, searchQuery, filterTags]);
  
  // Get all available tags for filtering
  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    snapshots.forEach(snapshot => {
      if (snapshot.tags) {
        snapshot.tags.forEach(tag => tags.add(tag));
      }
    });
    return Array.from(tags);
  }, [snapshots]);
  
  // Toggle a tag in the filter
  const toggleTagFilter = useCallback((tag: string) => {
    setFilterTags(prev => {
      if (prev.includes(tag)) {
        return prev.filter(t => t !== tag);
      } else {
        return [...prev, tag];
      }
    });
  }, []);
  
  return (
    <div className="jp-HistoryViewer">
      {/* Search and filter controls */}
      <div className="jp-HistoryViewer-controls">
        <div className="jp-HistoryViewer-search">
          <input 
            type="text"
            placeholder={trans.__('Search versions...')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="jp-HistoryViewer-searchInput"
          />
        </div>
        
        {availableTags.length > 0 && (
          <div className="jp-HistoryViewer-tagFilters">
            <span className="jp-HistoryViewer-tagFiltersLabel">
              {trans.__('Filter by tag:')}
            </span>
            {availableTags.map(tag => (
              <label key={tag} className="jp-HistoryViewer-tagFilter">
                <input 
                  type="checkbox"
                  checked={filterTags.includes(tag)}
                  onChange={() => toggleTagFilter(tag)}
                />
                {tag}
              </label>
            ))}
          </div>
        )}
      </div>
      
      {/* Error message */}
      {error && (
        <div className="jp-HistoryViewer-error">
          {error}
        </div>
      )}
      
      {/* Loading indicator */}
      {loading && (
        <div className="jp-HistoryViewer-loading">
          {trans.__('Loading...')}
        </div>
      )}
      
      {/* Main content */}
      <div className="jp-HistoryViewer-content">
        {/* Version timeline */}
        <div className="jp-HistoryViewer-sidebar">
          <VersionTimeline 
            snapshots={filteredSnapshots}
            selectedId={selectedId}
            comparisonId={comparisonId}
            onSelectSnapshot={handleSelectSnapshot}
            onSelectComparison={handleSelectComparison}
            translator={translator}
          />
        </div>
        
        {/* Diff view and restore controls */}
        <div className="jp-HistoryViewer-main">
          <DiffView 
            diff={diff}
            splitView={splitView}
            onToggleSplitView={() => setSplitView(!splitView)}
            sourceSnapshot={comparisonSnapshot}
            targetSnapshot={selectedSnapshot}
            translator={translator}
          />
          
          <RestoreControls 
            selectedSnapshot={selectedSnapshot}
            onRestoreNotebook={handleRestoreNotebook}
            onRestoreSelectedCells={handleRestoreSelectedCells}
            hasCellSelection={hasCellSelection}
            translator={translator}
          />
        </div>
      </div>
    </div>
  );
};

/**
 * A namespace for HistoryViewer static methods.
 */
export namespace HistoryViewerComponent {
  /**
   * Create a new HistoryViewer widget
   *
   * @param options - The options for creating the history viewer
   * @returns A ReactWidget containing the history viewer
   */
  export const create = (options: {
    notebookPanel: NotebookPanel;
    historyManager: IHistoryManager;
    translator?: ITranslator;
  }): ReactWidget => {
    return ReactWidget.create(
      <HistoryViewer 
        notebookPanel={options.notebookPanel}
        historyManager={options.historyManager}
        translator={options.translator}
      />
    );
  };
}