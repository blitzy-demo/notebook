/**
 * @fileoverview History Viewer Component for Collaborative Jupyter Notebooks
 * 
 * React component providing UI for viewing and navigating change history with timeline 
 * visualization, diff comparisons, and version restoration capabilities. Displays in the 
 * right sidebar via collaboration:historyPanel extension point.
 * 
 * This component enables users to:
 * - View chronological timeline of notebook changes with user attribution
 * - Compare versions with side-by-side and unified diff views
 * - Filter history by user, time range, and change type
 * - Restore previous versions with selective cell rollback
 * - Track real-time document evolution during collaborative sessions
 * 
 * @author Jupyter Development Team
 * @version 7.0.0
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookModel } from '@jupyterlab/notebook';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';

/**
 * Interface for YjsNotebookProvider integration.
 * Provides access to real-time collaboration data including history tracking.
 */
export interface IYjsNotebookProvider {
  /** Yjs awareness protocol for user presence */
  awareness: any;
  /** Cell-level locking mechanism */
  locks: any;
  /** Change history tracking */
  history: any;
  /** Access control and permissions */
  permissions: any;
  /** Comment and review system */
  comments: any;
  /** Connection status indicator */
  isConnected: boolean;
  /** Current connection state */
  connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error';
}

/**
 * Represents a single change entry in the notebook history.
 * Each entry contains metadata about the change and its content.
 */
export interface IHistoryEntry {
  /** Unique identifier for this history entry */
  id: string;
  /** Timestamp when the change occurred */
  timestamp: Date;
  /** User who made the change */
  user: {
    id: string;
    name: string;
    avatar?: string;
    color?: string;
  };
  /** Type of change performed */
  changeType: 'cell-added' | 'cell-modified' | 'cell-deleted' | 'cell-moved' | 'output-changed' | 'metadata-changed';
  /** Cell ID that was affected (if applicable) */
  cellId?: string;
  /** Cell index position */
  cellIndex?: number;
  /** Description of the change */
  description: string;
  /** Before state of the changed content */
  beforeState?: any;
  /** After state of the changed content */
  afterState?: any;
  /** Size of the change in characters */
  changeSize: number;
  /** Optional commit message from user */
  commitMessage?: string;
  /** Kernel state when change occurred */
  kernelState?: 'idle' | 'busy' | 'starting' | 'dead';
  /** Active session information */
  sessionInfo?: {
    duration: number;
    activeUsers: number;
    totalOperations: number;
  };
}

/**
 * Configuration for history filtering and display options.
 */
export interface IHistoryFilters {
  /** Filter by specific users */
  users: string[];
  /** Time range for filtering */
  timeRange: {
    start?: Date;
    end?: Date;
  };
  /** Filter by change types */
  changeTypes: IHistoryEntry['changeType'][];
  /** Search term for filtering descriptions */
  searchTerm: string;
  /** Maximum number of entries to display */
  limit: number;
}

/**
 * Diff comparison options and configuration.
 */
export interface IDiffOptions {
  /** Comparison mode */
  mode: 'side-by-side' | 'unified' | 'inline';
  /** Show line numbers */
  showLineNumbers: boolean;
  /** Ignore whitespace changes */
  ignoreWhitespace: boolean;
  /** Context lines around changes */
  contextLines: number;
  /** Syntax highlighting for code diffs */
  syntaxHighlighting: boolean;
}

/**
 * Props for the main HistoryViewer component.
 */
export interface IHistoryViewerProps {
  /** The notebook model for tracking changes */
  model: INotebookModel;
  /** YjsNotebookProvider for real-time collaboration */
  provider?: IYjsNotebookProvider;
  /** Translator for internationalization */
  translator?: ITranslator;
  /** Whether the component is in mobile view */
  isMobile?: boolean;
  /** Callback when history entry is selected */
  onEntrySelected?: (entry: IHistoryEntry) => void;
  /** Callback when version restoration is requested */
  onRestoreVersion?: (entry: IHistoryEntry, cellIds?: string[]) => void;
  /** Callback when diff view is opened */
  onOpenDiff?: (entryA: IHistoryEntry, entryB: IHistoryEntry) => void;
}

/**
 * Timeline visualization component showing chronological history.
 */
const HistoryTimeline: React.FC<{
  entries: IHistoryEntry[];
  selectedEntry: IHistoryEntry | null;
  onSelectEntry: (entry: IHistoryEntry) => void;
  isMobile: boolean;
}> = ({ entries, selectedEntry, onSelectEntry, isMobile }) => {
  const timelineRef = useRef<HTMLDivElement>(null);

  /**
   * Scroll timeline to a specific entry.
   */
  const scrollToEntry = useCallback((entryId: string) => {
    const element = timelineRef.current?.querySelector(`[data-entry-id="${entryId}"]`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  /**
   * Format timestamp for display based on viewport.
   */
  const formatTimestamp = useCallback((timestamp: Date) => {
    const now = new Date();
    const diff = now.getTime() - timestamp.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    
    return isMobile 
      ? timestamp.toLocaleDateString()
      : timestamp.toLocaleString();
  }, [isMobile]);

  /**
   * Get change type display information.
   */
  const getChangeTypeInfo = useCallback((changeType: IHistoryEntry['changeType']) => {
    const info = {
      'cell-added': { icon: '➕', color: '#28a745', label: 'Added' },
      'cell-modified': { icon: '✏️', color: '#007bff', label: 'Modified' },
      'cell-deleted': { icon: '🗑️', color: '#dc3545', label: 'Deleted' },
      'cell-moved': { icon: '↕️', color: '#6f42c1', label: 'Moved' },
      'output-changed': { icon: '📊', color: '#fd7e14', label: 'Output' },
      'metadata-changed': { icon: '⚙️', color: '#6c757d', label: 'Metadata' }
    };
    return info[changeType] || { icon: '📝', color: '#495057', label: 'Changed' };
  }, []);

  return (
    <div 
      ref={timelineRef}
      className={`jp-Collab-HistoryTimeline ${isMobile ? 'jp-Collab-HistoryTimeline-mobile' : ''}`}
    >
      <div className="jp-Collab-HistoryTimeline-header">
        <h3 className="jp-Collab-HistoryTimeline-title">Change History</h3>
        <span className="jp-Collab-HistoryTimeline-count">
          {entries.length} {entries.length === 1 ? 'change' : 'changes'}
        </span>
      </div>
      
      <div className="jp-Collab-HistoryTimeline-entries">
        {entries.map((entry, index) => {
          const changeInfo = getChangeTypeInfo(entry.changeType);
          const isSelected = selectedEntry?.id === entry.id;
          const isFirstOfDay = index === 0 || 
            entries[index - 1].timestamp.toDateString() !== entry.timestamp.toDateString();
          
          return (
            <React.Fragment key={entry.id}>
              {isFirstOfDay && (
                <div className="jp-Collab-HistoryTimeline-dateMarker">
                  {entry.timestamp.toLocaleDateString()}
                </div>
              )}
              
              <div 
                className={`jp-Collab-HistoryTimeline-entry ${isSelected ? 'selected' : ''}`}
                data-entry-id={entry.id}
                onClick={() => onSelectEntry(entry)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectEntry(entry);
                  }
                }}
              >
                <div className="jp-Collab-HistoryTimeline-entryContent">
                  <div className="jp-Collab-HistoryTimeline-entryHeader">
                    <div className="jp-Collab-HistoryTimeline-changeType">
                      <span 
                        className="jp-Collab-HistoryTimeline-changeIcon"
                        style={{ color: changeInfo.color }}
                      >
                        {changeInfo.icon}
                      </span>
                      <span className="jp-Collab-HistoryTimeline-changeLabel">
                        {changeInfo.label}
                      </span>
                    </div>
                    
                    <span className="jp-Collab-HistoryTimeline-timestamp">
                      {formatTimestamp(entry.timestamp)}
                    </span>
                  </div>
                  
                  <div className="jp-Collab-HistoryTimeline-description">
                    {entry.description}
                  </div>
                  
                  <div className="jp-Collab-HistoryTimeline-user">
                    {entry.user.avatar && (
                      <img 
                        src={entry.user.avatar} 
                        alt={entry.user.name}
                        className="jp-Collab-HistoryTimeline-userAvatar"
                      />
                    )}
                    <span 
                      className="jp-Collab-HistoryTimeline-userName"
                      style={{ color: entry.user.color }}
                    >
                      {entry.user.name}
                    </span>
                  </div>
                  
                  {!isMobile && entry.changeSize > 0 && (
                    <div className="jp-Collab-HistoryTimeline-changeSize">
                      {entry.changeSize > 0 ? '+' : ''}{entry.changeSize} chars
                    </div>
                  )}
                </div>
                
                <div className="jp-Collab-HistoryTimeline-connector" />
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Filtering controls for the history viewer.
 */
const HistoryFilters: React.FC<{
  filters: IHistoryFilters;
  availableUsers: Array<{ id: string; name: string; color?: string }>;
  onFiltersChange: (filters: IHistoryFilters) => void;
  isMobile: boolean;
}> = ({ filters, availableUsers, onFiltersChange, isMobile }) => {
  const [isExpanded, setIsExpanded] = useState(!isMobile);

  /**
   * Handle change type filter toggle.
   */
  const handleChangeTypeToggle = useCallback((changeType: IHistoryEntry['changeType']) => {
    const newChangeTypes = filters.changeTypes.includes(changeType)
      ? filters.changeTypes.filter(t => t !== changeType)
      : [...filters.changeTypes, changeType];
    
    onFiltersChange({
      ...filters,
      changeTypes: newChangeTypes
    });
  }, [filters, onFiltersChange]);

  /**
   * Handle user filter toggle.
   */
  const handleUserToggle = useCallback((userId: string) => {
    const newUsers = filters.users.includes(userId)
      ? filters.users.filter(u => u !== userId)
      : [...filters.users, userId];
    
    onFiltersChange({
      ...filters,
      users: newUsers
    });
  }, [filters, onFiltersChange]);

  /**
   * Clear all filters.
   */
  const clearFilters = useCallback(() => {
    onFiltersChange({
      users: [],
      timeRange: {},
      changeTypes: [],
      searchTerm: '',
      limit: 100
    });
  }, [onFiltersChange]);

  const activeFilterCount = filters.users.length + filters.changeTypes.length + 
    (filters.searchTerm ? 1 : 0) + 
    (filters.timeRange.start || filters.timeRange.end ? 1 : 0);

  return (
    <div className={`jp-Collab-HistoryFilters ${isMobile ? 'jp-Collab-HistoryFilters-mobile' : ''}`}>
      <div 
        className="jp-Collab-HistoryFilters-header"
        onClick={() => isMobile && setIsExpanded(!isExpanded)}
        role={isMobile ? "button" : undefined}
        tabIndex={isMobile ? 0 : undefined}
      >
        <h4 className="jp-Collab-HistoryFilters-title">
          Filters
          {activeFilterCount > 0 && (
            <span className="jp-Collab-HistoryFilters-count">({activeFilterCount})</span>
          )}
        </h4>
        {isMobile && (
          <span className={`jp-Collab-HistoryFilters-expandIcon ${isExpanded ? 'expanded' : ''}`}>
            ▼
          </span>
        )}
      </div>
      
      {isExpanded && (
        <div className="jp-Collab-HistoryFilters-content">
          {/* Search filter */}
          <div className="jp-Collab-HistoryFilters-section">
            <label className="jp-Collab-HistoryFilters-label">Search:</label>
            <input
              type="text"
              className="jp-Collab-HistoryFilters-search"
              placeholder="Search descriptions..."
              value={filters.searchTerm}
              onChange={(e) => onFiltersChange({ ...filters, searchTerm: e.target.value })}
            />
          </div>
          
          {/* User filters */}
          {availableUsers.length > 0 && (
            <div className="jp-Collab-HistoryFilters-section">
              <label className="jp-Collab-HistoryFilters-label">Users:</label>
              <div className="jp-Collab-HistoryFilters-userList">
                {availableUsers.map(user => (
                  <label 
                    key={user.id}
                    className="jp-Collab-HistoryFilters-userItem"
                  >
                    <input
                      type="checkbox"
                      checked={filters.users.includes(user.id)}
                      onChange={() => handleUserToggle(user.id)}
                    />
                    <span 
                      className="jp-Collab-HistoryFilters-userName"
                      style={{ color: user.color }}
                    >
                      {user.name}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          
          {/* Change type filters */}
          <div className="jp-Collab-HistoryFilters-section">
            <label className="jp-Collab-HistoryFilters-label">Change Types:</label>
            <div className="jp-Collab-HistoryFilters-changeTypes">
              {(['cell-added', 'cell-modified', 'cell-deleted', 'cell-moved', 'output-changed', 'metadata-changed'] as const).map(changeType => (
                <label 
                  key={changeType}
                  className="jp-Collab-HistoryFilters-changeTypeItem"
                >
                  <input
                    type="checkbox"
                    checked={filters.changeTypes.includes(changeType)}
                    onChange={() => handleChangeTypeToggle(changeType)}
                  />
                  <span className="jp-Collab-HistoryFilters-changeTypeName">
                    {changeType.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                  </span>
                </label>
              ))}
            </div>
          </div>
          
          {/* Time range filters */}
          <div className="jp-Collab-HistoryFilters-section">
            <label className="jp-Collab-HistoryFilters-label">Time Range:</label>
            <div className="jp-Collab-HistoryFilters-timeRange">
              <input
                type="datetime-local"
                className="jp-Collab-HistoryFilters-timeInput"
                value={filters.timeRange.start?.toISOString().slice(0, 16) || ''}
                onChange={(e) => onFiltersChange({
                  ...filters,
                  timeRange: {
                    ...filters.timeRange,
                    start: e.target.value ? new Date(e.target.value) : undefined
                  }
                })}
                placeholder="Start time"
              />
              <input
                type="datetime-local"
                className="jp-Collab-HistoryFilters-timeInput"
                value={filters.timeRange.end?.toISOString().slice(0, 16) || ''}
                onChange={(e) => onFiltersChange({
                  ...filters,
                  timeRange: {
                    ...filters.timeRange,
                    end: e.target.value ? new Date(e.target.value) : undefined
                  }
                })}
                placeholder="End time"
              />
            </div>
          </div>
          
          {/* Clear filters */}
          {activeFilterCount > 0 && (
            <button
              className="jp-Collab-HistoryFilters-clearButton"
              onClick={clearFilters}
            >
              Clear All Filters
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Diff comparison component for viewing changes between versions.
 */
const DiffViewer: React.FC<{
  entryA: IHistoryEntry;
  entryB: IHistoryEntry;
  options: IDiffOptions;
  onOptionsChange: (options: IDiffOptions) => void;
  onClose: () => void;
  isMobile: boolean;
}> = ({ entryA, entryB, options, onOptionsChange, onClose, isMobile }) => {
  const diffRef = useRef<HTMLDivElement>(null);

  /**
   * Generate diff visualization based on options.
   */
  const generateDiff = useMemo(() => {
    const beforeContent = entryA.afterState || '';
    const afterContent = entryB.afterState || '';
    
    // Simple diff algorithm for demonstration
    // In production, would use a proper diff library like 'diff'
    const lines1 = beforeContent.split('\n');
    const lines2 = afterContent.split('\n');
    
    const diffLines: Array<{
      type: 'unchanged' | 'added' | 'removed';
      lineNumber1?: number;
      lineNumber2?: number;
      content: string;
    }> = [];

    // Basic line-by-line comparison
    const maxLines = Math.max(lines1.length, lines2.length);
    for (let i = 0; i < maxLines; i++) {
      const line1 = lines1[i];
      const line2 = lines2[i];
      
      if (line1 === line2) {
        diffLines.push({
          type: 'unchanged',
          lineNumber1: i + 1,
          lineNumber2: i + 1,
          content: line1 || ''
        });
      } else if (line1 && !line2) {
        diffLines.push({
          type: 'removed',
          lineNumber1: i + 1,
          content: line1
        });
      } else if (!line1 && line2) {
        diffLines.push({
          type: 'added',
          lineNumber2: i + 1,
          content: line2
        });
      } else {
        // Both lines exist but are different
        diffLines.push({
          type: 'removed',
          lineNumber1: i + 1,
          content: line1
        });
        diffLines.push({
          type: 'added',
          lineNumber2: i + 1,
          content: line2
        });
      }
    }

    return diffLines;
  }, [entryA, entryB, options]);

  /**
   * Render diff in side-by-side mode.
   */
  const renderSideBySide = () => (
    <div className="jp-Collab-DiffViewer-sideBySide">
      <div className="jp-Collab-DiffViewer-column">
        <div className="jp-Collab-DiffViewer-columnHeader">
          Before ({entryA.timestamp.toLocaleString()})
        </div>
        <div className="jp-Collab-DiffViewer-columnContent">
          {generateDiff.map((line, index) => (
            line.type !== 'added' && (
              <div 
                key={index}
                className={`jp-Collab-DiffViewer-line ${line.type}`}
              >
                {options.showLineNumbers && line.lineNumber1 && (
                  <span className="jp-Collab-DiffViewer-lineNumber">
                    {line.lineNumber1}
                  </span>
                )}
                <span className="jp-Collab-DiffViewer-lineContent">
                  {line.content}
                </span>
              </div>
            )
          ))}
        </div>
      </div>
      
      <div className="jp-Collab-DiffViewer-column">
        <div className="jp-Collab-DiffViewer-columnHeader">
          After ({entryB.timestamp.toLocaleString()})
        </div>
        <div className="jp-Collab-DiffViewer-columnContent">
          {generateDiff.map((line, index) => (
            line.type !== 'removed' && (
              <div 
                key={index}
                className={`jp-Collab-DiffViewer-line ${line.type}`}
              >
                {options.showLineNumbers && line.lineNumber2 && (
                  <span className="jp-Collab-DiffViewer-lineNumber">
                    {line.lineNumber2}
                  </span>
                )}
                <span className="jp-Collab-DiffViewer-lineContent">
                  {line.content}
                </span>
              </div>
            )
          ))}
        </div>
      </div>
    </div>
  );

  /**
   * Render diff in unified mode.
   */
  const renderUnified = () => (
    <div className="jp-Collab-DiffViewer-unified">
      {generateDiff.map((line, index) => (
        <div 
          key={index}
          className={`jp-Collab-DiffViewer-line ${line.type}`}
        >
          {options.showLineNumbers && (
            <span className="jp-Collab-DiffViewer-lineNumber">
              {line.lineNumber1 || line.lineNumber2 || ''}
            </span>
          )}
          <span className="jp-Collab-DiffViewer-linePrefix">
            {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
          </span>
          <span className="jp-Collab-DiffViewer-lineContent">
            {line.content}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div className={`jp-Collab-DiffViewer ${isMobile ? 'jp-Collab-DiffViewer-mobile' : ''}`}>
      <div className="jp-Collab-DiffViewer-header">
        <h3 className="jp-Collab-DiffViewer-title">
          Comparing Changes
        </h3>
        
        <div className="jp-Collab-DiffViewer-controls">
          <select
            value={options.mode}
            onChange={(e) => onOptionsChange({
              ...options,
              mode: e.target.value as IDiffOptions['mode']
            })}
            className="jp-Collab-DiffViewer-modeSelect"
          >
            <option value="side-by-side">Side by Side</option>
            <option value="unified">Unified</option>
            <option value="inline">Inline</option>
          </select>
          
          <label className="jp-Collab-DiffViewer-option">
            <input
              type="checkbox"
              checked={options.showLineNumbers}
              onChange={(e) => onOptionsChange({
                ...options,
                showLineNumbers: e.target.checked
              })}
            />
            Line Numbers
          </label>
          
          <label className="jp-Collab-DiffViewer-option">
            <input
              type="checkbox"
              checked={options.ignoreWhitespace}
              onChange={(e) => onOptionsChange({
                ...options,
                ignoreWhitespace: e.target.checked
              })}
            />
            Ignore Whitespace
          </label>
          
          <button
            className="jp-Collab-DiffViewer-closeButton"
            onClick={onClose}
            aria-label="Close diff viewer"
          >
            ✕
          </button>
        </div>
      </div>
      
      <div 
        ref={diffRef}
        className="jp-Collab-DiffViewer-content"
      >
        {options.mode === 'side-by-side' ? renderSideBySide() : renderUnified()}
      </div>
    </div>
  );
};

/**
 * Version restoration component with selective cell rollback.
 */
const RestoreVersionDialog: React.FC<{
  entry: IHistoryEntry;
  availableCells: Array<{ id: string; content: string; type: 'code' | 'markdown' }>;
  onRestore: (cellIds?: string[]) => void;
  onCancel: () => void;
  isMobile: boolean;
}> = ({ entry, availableCells, onRestore, onCancel, isMobile }) => {
  const [selectedCells, setSelectedCells] = useState<string[]>([]);
  const [restoreFullDocument, setRestoreFullDocument] = useState(true);

  /**
   * Handle cell selection toggle.
   */
  const handleCellToggle = useCallback((cellId: string) => {
    setSelectedCells(prev => 
      prev.includes(cellId)
        ? prev.filter(id => id !== cellId)
        : [...prev, cellId]
    );
  }, []);

  /**
   * Handle restore mode change.
   */
  const handleRestoreModeChange = useCallback((fullDocument: boolean) => {
    setRestoreFullDocument(fullDocument);
    if (fullDocument) {
      setSelectedCells([]);
    }
  }, []);

  return (
    <div className={`jp-Collab-RestoreDialog ${isMobile ? 'jp-Collab-RestoreDialog-mobile' : ''}`}>
      <div className="jp-Collab-RestoreDialog-overlay" onClick={onCancel} />
      
      <div className="jp-Collab-RestoreDialog-content">
        <div className="jp-Collab-RestoreDialog-header">
          <h3 className="jp-Collab-RestoreDialog-title">
            Restore Version
          </h3>
          <button
            className="jp-Collab-RestoreDialog-closeButton"
            onClick={onCancel}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>
        
        <div className="jp-Collab-RestoreDialog-body">
          <div className="jp-Collab-RestoreDialog-entryInfo">
            <p><strong>Version:</strong> {entry.timestamp.toLocaleString()}</p>
            <p><strong>Author:</strong> {entry.user.name}</p>
            <p><strong>Change:</strong> {entry.description}</p>
          </div>
          
          <div className="jp-Collab-RestoreDialog-options">
            <label className="jp-Collab-RestoreDialog-optionLabel">
              <input
                type="radio"
                name="restoreMode"
                checked={restoreFullDocument}
                onChange={() => handleRestoreModeChange(true)}
              />
              Restore entire notebook to this version
            </label>
            
            <label className="jp-Collab-RestoreDialog-optionLabel">
              <input
                type="radio"
                name="restoreMode"
                checked={!restoreFullDocument}
                onChange={() => handleRestoreModeChange(false)}
              />
              Restore selected cells only
            </label>
          </div>
          
          {!restoreFullDocument && (
            <div className="jp-Collab-RestoreDialog-cellSelection">
              <h4>Select cells to restore:</h4>
              <div className="jp-Collab-RestoreDialog-cellList">
                {availableCells.map((cell, index) => (
                  <label 
                    key={cell.id}
                    className="jp-Collab-RestoreDialog-cellItem"
                  >
                    <input
                      type="checkbox"
                      checked={selectedCells.includes(cell.id)}
                      onChange={() => handleCellToggle(cell.id)}
                    />
                    <div className="jp-Collab-RestoreDialog-cellInfo">
                      <span className="jp-Collab-RestoreDialog-cellType">
                        {cell.type}
                      </span>
                      <span className="jp-Collab-RestoreDialog-cellIndex">
                        Cell {index + 1}
                      </span>
                      <div className="jp-Collab-RestoreDialog-cellPreview">
                        {cell.content.slice(0, 100)}
                        {cell.content.length > 100 && '...'}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        
        <div className="jp-Collab-RestoreDialog-footer">
          <button
            className="jp-Collab-RestoreDialog-cancelButton"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="jp-Collab-RestoreDialog-restoreButton"
            onClick={() => onRestore(restoreFullDocument ? undefined : selectedCells)}
            disabled={!restoreFullDocument && selectedCells.length === 0}
          >
            Restore {restoreFullDocument ? 'Full Version' : `${selectedCells.length} Cell${selectedCells.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Main History Viewer component providing comprehensive version tracking.
 * 
 * This component integrates with the YjsNotebookProvider to track real-time
 * document changes and provides a user interface for viewing, comparing,
 * and restoring previous versions of the notebook.
 */
export const HistoryViewer: React.FC<IHistoryViewerProps> = ({
  model,
  provider,
  translator = nullTranslator,
  isMobile = false,
  onEntrySelected,
  onRestoreVersion,
  onOpenDiff
}) => {
  // State management for history entries and UI
  const [historyEntries, setHistoryEntries] = useState<IHistoryEntry[]>([]);
  const [filteredEntries, setFilteredEntries] = useState<IHistoryEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<IHistoryEntry | null>(null);
  const [comparingEntries, setComparingEntries] = useState<[IHistoryEntry, IHistoryEntry] | null>(null);
  const [showRestoreDialog, setShowRestoreDialog] = useState<IHistoryEntry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Configuration state
  const [filters, setFilters] = useState<IHistoryFilters>({
    users: [],
    timeRange: {},
    changeTypes: [],
    searchTerm: '',
    limit: 100
  });

  const [diffOptions, setDiffOptions] = useState<IDiffOptions>({
    mode: 'side-by-side',
    showLineNumbers: true,
    ignoreWhitespace: false,
    contextLines: 3,
    syntaxHighlighting: true
  });

  // Refs for component lifecycle
  const mountedRef = useRef(true);
  const historySubscriptionRef = useRef<(() => void) | null>(null);

  /**
   * Subscribe to document update events for real-time history tracking.
   */
  const subscribeToHistory = useCallback(() => {
    if (!provider?.history) {
      console.warn('History provider not available');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Subscribe to Yjs history events
      const handleHistoryUpdate = (entries: any[]) => {
        if (!mountedRef.current) return;

        const parsedEntries: IHistoryEntry[] = entries.map((entry, index) => ({
          id: entry.id || `entry-${index}`,
          timestamp: new Date(entry.timestamp || Date.now()),
          user: {
            id: entry.user?.id || 'unknown',
            name: entry.user?.name || 'Unknown User',
            avatar: entry.user?.avatar,
            color: entry.user?.color || '#000000'
          },
          changeType: entry.changeType || 'cell-modified',
          cellId: entry.cellId,
          cellIndex: entry.cellIndex,
          description: entry.description || 'Document change',
          beforeState: entry.beforeState,
          afterState: entry.afterState,
          changeSize: entry.changeSize || 0,
          commitMessage: entry.commitMessage,
          kernelState: entry.kernelState,
          sessionInfo: entry.sessionInfo
        }));

        // Sort entries by timestamp (newest first)
        parsedEntries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

        setHistoryEntries(parsedEntries);
      };

      // Set up subscription based on provider API
      if (typeof provider.history.subscribe === 'function') {
        const unsubscribe = provider.history.subscribe(handleHistoryUpdate);
        historySubscriptionRef.current = unsubscribe;
      } else if (typeof provider.history.on === 'function') {
        provider.history.on('update', handleHistoryUpdate);
        historySubscriptionRef.current = () => provider.history.off('update', handleHistoryUpdate);
      }

      // Load initial history data
      if (typeof provider.history.getHistory === 'function') {
        provider.history.getHistory().then(handleHistoryUpdate);
      } else if (Array.isArray(provider.history.entries)) {
        handleHistoryUpdate(provider.history.entries);
      }

      setIsLoading(false);
    } catch (err) {
      console.error('Failed to subscribe to history:', err);
      setError('Failed to load change history');
      setIsLoading(false);
    }
  }, [provider]);

  /**
   * Filter history entries based on current filter settings.
   */
  const applyFilters = useCallback(() => {
    let filtered = [...historyEntries];

    // Filter by users
    if (filters.users.length > 0) {
      filtered = filtered.filter(entry => filters.users.includes(entry.user.id));
    }

    // Filter by change types
    if (filters.changeTypes.length > 0) {
      filtered = filtered.filter(entry => filters.changeTypes.includes(entry.changeType));
    }

    // Filter by time range
    if (filters.timeRange.start) {
      filtered = filtered.filter(entry => entry.timestamp >= filters.timeRange.start!);
    }
    if (filters.timeRange.end) {
      filtered = filtered.filter(entry => entry.timestamp <= filters.timeRange.end!);
    }

    // Filter by search term
    if (filters.searchTerm.trim()) {
      const searchLower = filters.searchTerm.toLowerCase();
      filtered = filtered.filter(entry => 
        entry.description.toLowerCase().includes(searchLower) ||
        entry.user.name.toLowerCase().includes(searchLower) ||
        entry.commitMessage?.toLowerCase().includes(searchLower)
      );
    }

    // Apply limit
    if (filters.limit > 0) {
      filtered = filtered.slice(0, filters.limit);
    }

    setFilteredEntries(filtered);
  }, [historyEntries, filters]);

  /**
   * Get unique users from history entries for filter options.
   */
  const availableUsers = useMemo(() => {
    const userMap = new Map<string, { id: string; name: string; color?: string }>();
    
    historyEntries.forEach(entry => {
      if (!userMap.has(entry.user.id)) {
        userMap.set(entry.user.id, {
          id: entry.user.id,
          name: entry.user.name,
          color: entry.user.color
        });
      }
    });

    return Array.from(userMap.values());
  }, [historyEntries]);

  /**
   * Handle history entry selection.
   */
  const handleEntrySelect = useCallback((entry: IHistoryEntry) => {
    setSelectedEntry(entry);
    onEntrySelected?.(entry);
  }, [onEntrySelected]);

  /**
   * Handle version restoration request.
   */
  const handleRestoreRequest = useCallback((entry: IHistoryEntry) => {
    setShowRestoreDialog(entry);
  }, []);

  /**
   * Handle actual version restoration.
   */
  const handleRestore = useCallback((cellIds?: string[]) => {
    if (showRestoreDialog) {
      onRestoreVersion?.(showRestoreDialog, cellIds);
      setShowRestoreDialog(null);
    }
  }, [showRestoreDialog, onRestoreVersion]);

  /**
   * Handle diff comparison request.
   */
  const handleCompareRequest = useCallback((entryA: IHistoryEntry, entryB: IHistoryEntry) => {
    setComparingEntries([entryA, entryB]);
    onOpenDiff?.(entryA, entryB);
  }, [onOpenDiff]);

  /**
   * Initialize component and set up subscriptions.
   */
  useEffect(() => {
    mountedRef.current = true;
    subscribeToHistory();

    return () => {
      mountedRef.current = false;
      if (historySubscriptionRef.current) {
        historySubscriptionRef.current();
        historySubscriptionRef.current = null;
      }
    };
  }, [subscribeToHistory]);

  /**
   * Apply filters when entries or filter settings change.
   */
  useEffect(() => {
    applyFilters();
  }, [applyFilters]);

  /**
   * Get available cells for restoration dialog.
   */
  const getAvailableCells = useCallback(() => {
    if (!model || !model.cells) {
      return [];
    }

    return Array.from(model.cells.iter()).map((cell, index) => ({
      id: cell.id,
      content: cell.value.text,
      type: cell.type as 'code' | 'markdown'
    }));
  }, [model]);

  // Render loading state
  if (isLoading) {
    return (
      <div className="jp-Collab-HistoryViewer jp-Collab-HistoryViewer-loading">
        <div className="jp-Collab-HistoryViewer-loadingSpinner">
          <div className="jp-Collab-HistoryViewer-spinner" />
          <span>Loading history...</span>
        </div>
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className="jp-Collab-HistoryViewer jp-Collab-HistoryViewer-error">
        <div className="jp-Collab-HistoryViewer-errorMessage">
          <span className="jp-Collab-HistoryViewer-errorIcon">⚠️</span>
          <div>
            <h4>Failed to load history</h4>
            <p>{error}</p>
            <button 
              className="jp-Collab-HistoryViewer-retryButton"
              onClick={subscribeToHistory}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Render main component
  return (
    <div className={`jp-Collab-HistoryViewer ${isMobile ? 'jp-Collab-HistoryViewer-mobile' : ''}`}>
      {/* Filters */}
      <HistoryFilters
        filters={filters}
        availableUsers={availableUsers}
        onFiltersChange={setFilters}
        isMobile={isMobile}
      />

      {/* Timeline */}
      <HistoryTimeline
        entries={filteredEntries}
        selectedEntry={selectedEntry}
        onSelectEntry={handleEntrySelect}
        isMobile={isMobile}
      />

      {/* Entry actions */}
      {selectedEntry && (
        <div className="jp-Collab-HistoryViewer-actions">
          <button
            className="jp-Collab-HistoryViewer-actionButton"
            onClick={() => handleRestoreRequest(selectedEntry)}
            disabled={!onRestoreVersion}
          >
            Restore Version
          </button>
          
          {filteredEntries.length > 1 && (
            <button
              className="jp-Collab-HistoryViewer-actionButton"
              onClick={() => {
                const currentIndex = filteredEntries.findIndex(e => e.id === selectedEntry.id);
                if (currentIndex > 0) {
                  handleCompareRequest(filteredEntries[currentIndex + 1], selectedEntry);
                }
              }}
              disabled={!onOpenDiff || filteredEntries.findIndex(e => e.id === selectedEntry.id) <= 0}
            >
              Compare with Previous
            </button>
          )}
        </div>
      )}

      {/* Diff viewer modal */}
      {comparingEntries && (
        <DiffViewer
          entryA={comparingEntries[0]}
          entryB={comparingEntries[1]}
          options={diffOptions}
          onOptionsChange={setDiffOptions}
          onClose={() => setComparingEntries(null)}
          isMobile={isMobile}
        />
      )}

      {/* Restore version dialog */}
      {showRestoreDialog && (
        <RestoreVersionDialog
          entry={showRestoreDialog}
          availableCells={getAvailableCells()}
          onRestore={handleRestore}
          onCancel={() => setShowRestoreDialog(null)}
          isMobile={isMobile}
        />
      )}

      {/* Empty state */}
      {filteredEntries.length === 0 && !isLoading && (
        <div className="jp-Collab-HistoryViewer-empty">
          <div className="jp-Collab-HistoryViewer-emptyIcon">📝</div>
          <h3>No History Available</h3>
          <p>
            {historyEntries.length === 0 
              ? "No changes have been made to this notebook yet."
              : "No entries match your current filters."}
          </p>
          {historyEntries.length > 0 && (
            <button
              className="jp-Collab-HistoryViewer-clearFiltersButton"
              onClick={() => setFilters({
                users: [],
                timeRange: {},
                changeTypes: [],
                searchTerm: '',
                limit: 100
              })}
            >
              Clear Filters
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Widget wrapper for the History Viewer component.
 * Provides integration with the JupyterLab widget system and shell areas.
 */
export class HistoryViewerWidget extends ReactWidget {
  private _model: INotebookModel;
  private _provider?: IYjsNotebookProvider;
  private _translator: ITranslator;
  private _disposed = new Signal<this, void>(this);

  constructor(options: {
    model: INotebookModel;
    provider?: IYjsNotebookProvider;
    translator?: ITranslator;
  }) {
    super();
    this._model = options.model;
    this._provider = options.provider;
    this._translator = options.translator || nullTranslator;

    this.addClass('jp-Collab-HistoryViewerWidget');
    this.id = 'collaboration-history-viewer';
    this.title.label = 'History';
    this.title.icon = '📜'; // Unicode icon for history
    this.title.closable = true;
  }

  /**
   * A signal emitted when the widget is disposed.
   */
  get disposed(): Signal<this, void> {
    return this._disposed;
  }

  /**
   * Set the collaboration provider.
   */
  setProvider(provider: IYjsNotebookProvider | undefined): void {
    this._provider = provider;
    this.update();
  }

  /**
   * Handle history entry selection.
   */
  private _onEntrySelected = (entry: IHistoryEntry): void => {
    console.log('History entry selected:', entry);
    // Could emit a signal or call a callback here
  };

  /**
   * Handle version restoration.
   */
  private _onRestoreVersion = (entry: IHistoryEntry, cellIds?: string[]): void => {
    console.log('Restore version requested:', entry, cellIds);
    // Implement restoration logic here
    // This would integrate with the notebook model to restore content
  };

  /**
   * Handle diff comparison.
   */
  private _onOpenDiff = (entryA: IHistoryEntry, entryB: IHistoryEntry): void => {
    console.log('Diff comparison requested:', entryA, entryB);
    // Could open diff in a separate widget or modal
  };

  /**
   * Render the React component.
   */
  protected render(): JSX.Element {
    // Check for mobile viewport
    const isMobile = window.innerWidth <= 768;

    return (
      <HistoryViewer
        model={this._model}
        provider={this._provider}
        translator={this._translator}
        isMobile={isMobile}
        onEntrySelected={this._onEntrySelected}
        onRestoreVersion={this._onRestoreVersion}
        onOpenDiff={this._onOpenDiff}
      />
    );
  }

  /**
   * Dispose of the widget resources.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._disposed.emit();
    super.dispose();
  }
}

/**
 * Default export for the History Viewer component.
 */
export default HistoryViewer;