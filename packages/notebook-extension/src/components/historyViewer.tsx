import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { Message } from '@lumino/messaging';
import { Panel, Widget } from '@lumino/widgets';
import { Signal, ISignal } from '@lumino/signaling';

import React, { useEffect, useState, useCallback, useMemo } from 'react';

// Interface definitions based on technical specification
interface IVersionEntry {
  id: string;
  version: number;
  author: string;
  timestamp: number;
  summary: string;
  changesCount: number;
  cellsModified: number[];
  content?: string;
}

interface IHistoryDiff {
  cellId: number;
  oldContent: string;
  newContent: string;
  changeType: 'added' | 'modified' | 'deleted';
}

interface IHistoryService {
  versions: IVersionEntry[];
  selectedVersion: IVersionEntry | null;
  versionsChanged: ISignal<IHistoryService, IVersionEntry[]>;
  selectionChanged: ISignal<IHistoryService, IVersionEntry | null>;
  getVersionHistory(): Promise<IVersionEntry[]>;
  selectVersion(version: IVersionEntry): void;
  restoreVersion(version: IVersionEntry): Promise<boolean>;
  getDiff(fromVersion: IVersionEntry, toVersion?: IVersionEntry): Promise<IHistoryDiff[]>;
}

interface ICollaborationProvider {
  historyService: IHistoryService;
  isConnected: boolean;
  connectionChanged: ISignal<ICollaborationProvider, boolean>;
}

// Mock implementation for development - will be replaced by actual service
class MockHistoryService implements IHistoryService {
  private _versions: IVersionEntry[] = [];
  private _selectedVersion: IVersionEntry | null = null;
  private _versionsChanged = new Signal<IHistoryService, IVersionEntry[]>(this);
  private _selectionChanged = new Signal<IHistoryService, IVersionEntry | null>(this);

  get versions(): IVersionEntry[] {
    return this._versions;
  }

  get selectedVersion(): IVersionEntry | null {
    return this._selectedVersion;
  }

  get versionsChanged(): ISignal<IHistoryService, IVersionEntry[]> {
    return this._versionsChanged;
  }

  get selectionChanged(): ISignal<IHistoryService, IVersionEntry | null> {
    return this._selectionChanged;
  }

  async getVersionHistory(): Promise<IVersionEntry[]> {
    // Mock data for demonstration
    const mockVersions: IVersionEntry[] = [
      {
        id: 'v-001',
        version: 42,
        author: 'User A',
        timestamp: Date.now() - 3600000, // 1 hour ago
        summary: 'Modified cell #2',
        changesCount: 1,
        cellsModified: [2]
      },
      {
        id: 'v-002',
        version: 41,
        author: 'User B',
        timestamp: Date.now() - 7200000, // 2 hours ago
        summary: 'Added new cell',
        changesCount: 2,
        cellsModified: [3, 4]
      },
      {
        id: 'v-003',
        version: 40,
        author: 'User A',
        timestamp: Date.now() - 10800000, // 3 hours ago
        summary: 'Updated markdown',
        changesCount: 1,
        cellsModified: [1]
      },
      {
        id: 'v-004',
        version: 39,
        author: 'User C',
        timestamp: Date.now() - 86400000, // 1 day ago
        summary: 'Initial version',
        changesCount: 3,
        cellsModified: [0, 1, 2]
      }
    ];

    this._versions = mockVersions;
    this._versionsChanged.emit(mockVersions);
    return mockVersions;
  }

  selectVersion(version: IVersionEntry): void {
    this._selectedVersion = version;
    this._selectionChanged.emit(version);
  }

  async restoreVersion(version: IVersionEntry): Promise<boolean> {
    // Mock restoration - in real implementation, this would interact with the notebook model
    return new Promise((resolve) => {
      setTimeout(() => {
        console.log(`Restoring version ${version.version} by ${version.author}`);
        resolve(true);
      }, 1000);
    });
  }

  async getDiff(fromVersion: IVersionEntry, toVersion?: IVersionEntry): Promise<IHistoryDiff[]> {
    // Mock diff generation
    return [
      {
        cellId: 2,
        oldContent: 'x = np.linspace(0, 10, 100)\nplt.plot(x, np.sin(x))',
        newContent: 'x = np.linspace(0, 10, 1000)  # Higher resolution\nplt.plot(x, np.sin(x), \'r-\')  # Red line\nplt.xlabel(\'x values\')\nplt.ylabel(\'sin(x)\')',
        changeType: 'modified'
      }
    ];
  }
}

/**
 * Format timestamp for display
 */
const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {
    return `Today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffDays === 1) {
    return `Yesterday ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
};

/**
 * Format a diff line for display
 */
const formatDiffLine = (line: string, type: 'added' | 'removed' | 'unchanged'): JSX.Element => {
  const className = `jp-HistoryViewer-diffLine jp-HistoryViewer-diffLine-${type}`;
  const prefix = type === 'added' ? '+ ' : type === 'removed' ? '- ' : '  ';
  
  return (
    <div key={line} className={className}>
      <span className="jp-HistoryViewer-diffPrefix">{prefix}</span>
      <span className="jp-HistoryViewer-diffContent">{line}</span>
    </div>
  );
};

/**
 * Generate unified diff display from old and new content
 */
const generateUnifiedDiff = (oldContent: string, newContent: string): JSX.Element[] => {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diffElements: JSX.Element[] = [];
  
  // Simple diff algorithm - in real implementation would use proper diff library
  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    
    if (oldLine && !newLine) {
      diffElements.push(formatDiffLine(oldLine, 'removed'));
    } else if (!oldLine && newLine) {
      diffElements.push(formatDiffLine(newLine, 'added'));
    } else if (oldLine !== newLine) {
      if (oldLine) {
        diffElements.push(formatDiffLine(oldLine, 'removed'));
      }
      if (newLine) {
        diffElements.push(formatDiffLine(newLine, 'added'));
      }
    } else if (oldLine === newLine) {
      diffElements.push(formatDiffLine(oldLine, 'unchanged'));
    }
  }
  
  return diffElements;
};

/**
 * React component for version timeline
 */
const VersionTimeline: React.FC<{
  versions: IVersionEntry[];
  selectedVersion: IVersionEntry | null;
  onVersionSelect: (version: IVersionEntry) => void;
}> = ({ versions, selectedVersion, onVersionSelect }) => {
  const sortedVersions = useMemo(() => {
    return [...versions].sort((a, b) => b.timestamp - a.timestamp);
  }, [versions]);

  return (
    <div className="jp-HistoryViewer-timeline">
      {sortedVersions.map((version, index) => (
        <div
          key={version.id}
          className={`jp-HistoryViewer-timelineItem ${
            selectedVersion?.id === version.id ? 'jp-HistoryViewer-timelineItem-selected' : ''
          }`}
          onClick={() => onVersionSelect(version)}
        >
          <div className="jp-HistoryViewer-timelineMarker">
            {index === 0 ? '●' : '○'}
          </div>
          <div className="jp-HistoryViewer-timelineContent">
            <div className="jp-HistoryViewer-timelineHeader">
              <span className="jp-HistoryViewer-timelineTimestamp">
                {formatTimestamp(version.timestamp)}
              </span>
              <span className="jp-HistoryViewer-timelineAuthor">
                {version.author}
              </span>
            </div>
            <div className="jp-HistoryViewer-timelineSummary">
              {version.summary}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * React component for version details panel
 */
const VersionDetails: React.FC<{
  version: IVersionEntry | null;
  onRestore: (version: IVersionEntry) => void;
  isRestoring: boolean;
}> = ({ version, onRestore, isRestoring }) => {
  if (!version) {
    return (
      <div className="jp-HistoryViewer-details">
        <div className="jp-HistoryViewer-noSelection">
          Select a version to view details
        </div>
      </div>
    );
  }

  return (
    <div className="jp-HistoryViewer-details">
      <div className="jp-HistoryViewer-detailsHeader">Details</div>
      <div className="jp-HistoryViewer-detailsContent">
        <div className="jp-HistoryViewer-detailsRow">
          <span className="jp-HistoryViewer-detailsLabel">Version:</span>
          <span className="jp-HistoryViewer-detailsValue">#{version.version}</span>
        </div>
        <div className="jp-HistoryViewer-detailsRow">
          <span className="jp-HistoryViewer-detailsLabel">Author:</span>
          <span className="jp-HistoryViewer-detailsValue">{version.author}</span>
        </div>
        <div className="jp-HistoryViewer-detailsRow">
          <span className="jp-HistoryViewer-detailsLabel">Date:</span>
          <span className="jp-HistoryViewer-detailsValue">
            {formatTimestamp(version.timestamp)}
          </span>
        </div>
        <div className="jp-HistoryViewer-detailsRow">
          <span className="jp-HistoryViewer-detailsLabel">Changes:</span>
          <span className="jp-HistoryViewer-detailsValue">
            {version.changesCount} cell{version.changesCount !== 1 ? 's' : ''} modified
          </span>
        </div>
      </div>
      <button
        className="jp-HistoryViewer-restoreButton"
        onClick={() => onRestore(version)}
        disabled={isRestoring}
      >
        {isRestoring ? 'Restoring...' : 'Restore'}
      </button>
    </div>
  );
};

/**
 * React component for diff viewer
 */
const DiffViewer: React.FC<{
  diff: IHistoryDiff[];
  viewMode: 'unified' | 'sideBySide';
  onViewModeChange: (mode: 'unified' | 'sideBySide') => void;
}> = ({ diff, viewMode, onViewModeChange }) => {
  if (diff.length === 0) {
    return (
      <div className="jp-HistoryViewer-diff">
        <div className="jp-HistoryViewer-diffHeader">
          <span>Diff View</span>
          <div className="jp-HistoryViewer-diffControls">
            <button
              className={viewMode === 'unified' ? 'jp-HistoryViewer-diffControl-active' : ''}
              onClick={() => onViewModeChange('unified')}
            >
              Unified
            </button>
            <button
              className={viewMode === 'sideBySide' ? 'jp-HistoryViewer-diffControl-active' : ''}
              onClick={() => onViewModeChange('sideBySide')}
            >
              Side by Side
            </button>
          </div>
        </div>
        <div className="jp-HistoryViewer-noDiff">
          No changes to display
        </div>
      </div>
    );
  }

  return (
    <div className="jp-HistoryViewer-diff">
      <div className="jp-HistoryViewer-diffHeader">
        <span>Diff View</span>
        <div className="jp-HistoryViewer-diffControls">
          <button
            className={viewMode === 'unified' ? 'jp-HistoryViewer-diffControl-active' : ''}
            onClick={() => onViewModeChange('unified')}
          >
            Unified
          </button>
          <button
            className={viewMode === 'sideBySide' ? 'jp-HistoryViewer-diffControl-active' : ''}
            onClick={() => onViewModeChange('sideBySide')}
          >
            Side by Side
          </button>
        </div>
      </div>
      <div className={`jp-HistoryViewer-diffContent jp-HistoryViewer-diffContent-${viewMode}`}>
        {diff.map(change => (
          <div key={`cell-${change.cellId}`} className="jp-HistoryViewer-diffCell">
            <div className="jp-HistoryViewer-diffCellHeader">
              Cell #{change.cellId} - {change.changeType}
            </div>
            <div className="jp-HistoryViewer-diffCellContent">
              {viewMode === 'unified' ? (
                <div className="jp-HistoryViewer-unifiedDiff">
                  {generateUnifiedDiff(change.oldContent, change.newContent)}
                </div>
              ) : (
                <div className="jp-HistoryViewer-sideBySideDiff">
                  <div className="jp-HistoryViewer-sideBySide-old">
                    <div className="jp-HistoryViewer-sideBySide-header">Before</div>
                    <pre className="jp-HistoryViewer-sideBySide-content">
                      {change.oldContent}
                    </pre>
                  </div>
                  <div className="jp-HistoryViewer-sideBySide-new">
                    <div className="jp-HistoryViewer-sideBySide-header">After</div>
                    <pre className="jp-HistoryViewer-sideBySide-content">
                      {change.newContent}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/**
 * Main History Viewer React component
 */
const HistoryViewer: React.FC<{
  collaborationProvider: ICollaborationProvider | null;
  translator: ITranslator;
  notebookPath: string;
}> = ({ collaborationProvider, translator, notebookPath }) => {
  const trans = translator.load('notebook');
  const [versions, setVersions] = useState<IVersionEntry[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<IVersionEntry | null>(null);
  const [diff, setDiff] = useState<IHistoryDiff[]>([]);
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'sideBySide'>('unified');
  const [isRestoring, setIsRestoring] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Use mock service if collaboration provider is not available
  const historyService = useMemo(() => {
    return collaborationProvider?.historyService || new MockHistoryService();
  }, [collaborationProvider]);

  // Load version history on mount
  useEffect(() => {
    const loadHistory = async () => {
      setIsLoading(true);
      try {
        await historyService.getVersionHistory();
      } catch (error) {
        console.error('Failed to load version history:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadHistory();
  }, [historyService]);

  // Listen to history service signals
  useEffect(() => {
    const onVersionsChanged = (sender: IHistoryService, versions: IVersionEntry[]) => {
      setVersions(versions);
    };

    const onSelectionChanged = (sender: IHistoryService, version: IVersionEntry | null) => {
      setSelectedVersion(version);
    };

    historyService.versionsChanged.connect(onVersionsChanged);
    historyService.selectionChanged.connect(onSelectionChanged);

    return () => {
      historyService.versionsChanged.disconnect(onVersionsChanged);
      historyService.selectionChanged.disconnect(onSelectionChanged);
    };
  }, [historyService]);

  // Update diff when selected version changes
  useEffect(() => {
    const updateDiff = async () => {
      if (!selectedVersion) {
        setDiff([]);
        return;
      }

      try {
        const diffResult = await historyService.getDiff(selectedVersion);
        setDiff(diffResult);
      } catch (error) {
        console.error('Failed to generate diff:', error);
        setDiff([]);
      }
    };

    updateDiff();
  }, [selectedVersion, historyService]);

  const handleVersionSelect = useCallback((version: IVersionEntry) => {
    historyService.selectVersion(version);
  }, [historyService]);

  const handleRestore = useCallback(async (version: IVersionEntry) => {
    setIsRestoring(true);
    try {
      const success = await historyService.restoreVersion(version);
      if (success) {
        // Reload history after successful restore
        await historyService.getVersionHistory();
      }
    } catch (error) {
      console.error('Failed to restore version:', error);
    } finally {
      setIsRestoring(false);
    }
  }, [historyService]);

  const getNotebookName = () => {
    return notebookPath.split('/').pop() || 'Untitled.ipynb';
  };

  if (isLoading) {
    return (
      <div className="jp-HistoryViewer">
        <div className="jp-HistoryViewer-header">
          <span>History: {getNotebookName()}</span>
        </div>
        <div className="jp-HistoryViewer-loading">Loading version history...</div>
      </div>
    );
  }

  return (
    <div className="jp-HistoryViewer">
      <div className="jp-HistoryViewer-header">
        <span>History: {getNotebookName()}</span>
        <div className="jp-HistoryViewer-controls">
          <button
            className="jp-HistoryViewer-refreshButton"
            onClick={() => historyService.getVersionHistory()}
            title="Refresh history"
          >
            ⟳
          </button>
        </div>
      </div>
      
      <div className="jp-HistoryViewer-content">
        <div className="jp-HistoryViewer-upperPanel">
          <div className="jp-HistoryViewer-timelinePanel">
            <div className="jp-HistoryViewer-panelHeader">Timeline</div>
            <VersionTimeline
              versions={versions}
              selectedVersion={selectedVersion}
              onVersionSelect={handleVersionSelect}
            />
          </div>
          
          <div className="jp-HistoryViewer-detailsPanel">
            <VersionDetails
              version={selectedVersion}
              onRestore={handleRestore}
              isRestoring={isRestoring}
            />
          </div>
        </div>
        
        <div className="jp-HistoryViewer-lowerPanel">
          <DiffViewer
            diff={diff}
            viewMode={diffViewMode}
            onViewModeChange={setDiffViewMode}
          />
        </div>
      </div>
    </div>
  );
};

/**
 * Lumino Widget wrapper for the History Viewer
 */
export class HistoryViewerWidget extends ReactWidget {
  private _collaborationProvider: ICollaborationProvider | null = null;
  private _translator: ITranslator;
  private _notebookPath: string = '';

  constructor(options: {
    collaborationProvider?: ICollaborationProvider;
    translator: ITranslator;
    notebookPath?: string;
  }) {
    super();
    this._collaborationProvider = options.collaborationProvider || null;
    this._translator = options.translator;
    this._notebookPath = options.notebookPath || '';
    
    this.addClass('jp-HistoryViewer-widget');
    this.title.label = 'History';
    this.title.caption = 'Version History Viewer';
    this.title.iconClass = 'jp-HistoryIcon';
    this.title.closable = true;
  }

  /**
   * Update the collaboration provider
   */
  setCollaborationProvider(provider: ICollaborationProvider): void {
    this._collaborationProvider = provider;
    this.update();
  }

  /**
   * Update the notebook path
   */
  setNotebookPath(path: string): void {
    this._notebookPath = path;
    this.update();
  }

  protected render(): JSX.Element {
    return (
      <HistoryViewer
        collaborationProvider={this._collaborationProvider}
        translator={this._translator}
        notebookPath={this._notebookPath}
      />
    );
  }

  protected onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
  }
}

/**
 * A namespace for HistoryViewerComponent static methods
 */
export namespace HistoryViewerComponent {
  /**
   * Create a new HistoryViewerWidget
   */
  export const create = (options: {
    collaborationProvider?: ICollaborationProvider;
    translator: ITranslator;
    notebookPath?: string;
  }): HistoryViewerWidget => {
    return new HistoryViewerWidget(options);
  };

  /**
   * Create a dockable panel containing the history viewer
   */
  export const createPanel = (options: {
    collaborationProvider?: ICollaborationProvider;
    translator: ITranslator;
    notebookPath?: string;
  }): Panel => {
    const widget = create(options);
    const panel = new Panel();
    panel.addWidget(widget);
    panel.addClass('jp-HistoryViewer-panel');
    panel.title.label = 'History';
    panel.title.caption = 'Version History Viewer';
    panel.title.iconClass = 'jp-HistoryIcon';
    panel.title.closable = true;
    return panel;
  };
}