/**
 * @fileoverview Version control interface component enabling browsing of document history,
 * diff visualization, and selective rollback of collaborative changes.
 * 
 * This component provides comprehensive version tracking with detailed change attribution,
 * diff visualization between document states, and selective rollback capabilities for
 * collaborative audit trails. The implementation includes:
 * 
 * - Timeline-based version navigation with chronological ordering
 * - Side-by-side and inline diff visualization modes
 * - Change attribution with user identification and timestamps
 * - Selective rollback with version consistency validation
 * - PostgreSQL metadata integration for structured queries
 * - S3 snapshot storage integration for version retrieval
 * - Version permalinks and shareable URLs for collaboration
 * - Real-time synchronization with collaborative changes
 * 
 * @author Jupyter Collaboration Team
 * @version 1.0.0
 * @since 2024-12-15
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { ISignal } from '@lumino/signaling';
import { 
    Dialog, 
    showDialog, 
    showErrorMessage,
    Spinner
} from '@jupyterlab/apputils';
import { 
    INotebookContent,
    ICollaborationProvider,
    YjsNotebookProvider
} from '../../../notebook/src/collab/YjsNotebookProvider';
import { 
    IHistoryService,
    IVersionSnapshot,
    ICRDTOperation,
    HistoryUtils
} from '../../../notebook/src/collab/history';

/**
 * Interface for diff view configuration
 */
interface IDiffViewConfig {
    mode: 'side-by-side' | 'inline';
    showMetadata: boolean;
    showLineNumbers: boolean;
    highlightChanges: boolean;
    contextLines: number;
}

/**
 * Interface for version selection state
 */
interface IVersionSelection {
    fromVersion: number | null;
    toVersion: number | null;
    isComparing: boolean;
}

/**
 * Interface for history viewer state
 */
interface IHistoryViewerState {
    versions: IVersionSnapshot[];
    operations: ICRDTOperation[];
    isLoading: boolean;
    error: string | null;
    selectedVersion: IVersionSnapshot | null;
    diffConfig: IDiffViewConfig;
    versionSelection: IVersionSelection;
    searchQuery: string;
    filterBy: {
        contributor: string | null;
        dateRange: { start: Date | null; end: Date | null };
        changeType: string | null;
    };
    currentPage: number;
    totalPages: number;
    itemsPerPage: number;
}

/**
 * Props for the HistoryViewer component
 */
interface IHistoryViewerProps {
    collaborationProvider: ICollaborationProvider;
    historyService: IHistoryService;
    translator: ITranslator;
    onClose: () => void;
    initialVersion?: number;
}

/**
 * Default diff view configuration
 */
const DEFAULT_DIFF_CONFIG: IDiffViewConfig = {
    mode: 'side-by-side',
    showMetadata: true,
    showLineNumbers: true,
    highlightChanges: true,
    contextLines: 3
};

/**
 * Default history viewer state
 */
const DEFAULT_STATE: Omit<IHistoryViewerState, 'versions' | 'operations'> = {
    isLoading: false,
    error: null,
    selectedVersion: null,
    diffConfig: DEFAULT_DIFF_CONFIG,
    versionSelection: {
        fromVersion: null,
        toVersion: null,
        isComparing: false
    },
    searchQuery: '',
    filterBy: {
        contributor: null,
        dateRange: { start: null, end: null },
        changeType: null
    },
    currentPage: 1,
    totalPages: 1,
    itemsPerPage: 20
};

/**
 * HistoryViewer React component for document version tracking and diff visualization
 */
const HistoryViewer: React.FC<IHistoryViewerProps> = ({
    collaborationProvider,
    historyService,
    translator,
    onClose,
    initialVersion
}) => {
    const trans = translator.load('notebook');
    
    // Component state
    const [state, setState] = useState<IHistoryViewerState>({
        ...DEFAULT_STATE,
        versions: [],
        operations: []
    });

    // Memoized filtered and sorted versions
    const filteredVersions = useMemo(() => {
        let filtered = [...state.versions];
        
        // Apply search filter
        if (state.searchQuery) {
            const query = state.searchQuery.toLowerCase();
            filtered = filtered.filter(version => 
                version.changeSummary.toLowerCase().includes(query) ||
                version.contributorId.toLowerCase().includes(query) ||
                version.snapshotId.toLowerCase().includes(query)
            );
        }
        
        // Apply contributor filter
        if (state.filterBy.contributor) {
            filtered = filtered.filter(version => 
                version.contributorId === state.filterBy.contributor
            );
        }
        
        // Apply date range filter
        if (state.filterBy.dateRange.start || state.filterBy.dateRange.end) {
            filtered = filtered.filter(version => {
                const versionDate = version.timestamp;
                const start = state.filterBy.dateRange.start;
                const end = state.filterBy.dateRange.end;
                
                if (start && versionDate < start) return false;
                if (end && versionDate > end) return false;
                return true;
            });
        }
        
        // Sort by version number (descending)
        filtered.sort((a, b) => b.version - a.version);
        
        return filtered;
    }, [state.versions, state.searchQuery, state.filterBy]);

    // Memoized paginated versions
    const paginatedVersions = useMemo(() => {
        const startIndex = (state.currentPage - 1) * state.itemsPerPage;
        const endIndex = startIndex + state.itemsPerPage;
        return filteredVersions.slice(startIndex, endIndex);
    }, [filteredVersions, state.currentPage, state.itemsPerPage]);

    // Load version history
    const loadVersionHistory = useCallback(async () => {
        setState(prev => ({ ...prev, isLoading: true, error: null }));
        
        try {
            const versions = await historyService.getVersionHistory({
                limit: 1000, // Load all versions for client-side filtering
                offset: 0
            });
            
            const totalPages = Math.ceil(filteredVersions.length / state.itemsPerPage);
            
            setState(prev => ({
                ...prev,
                versions,
                totalPages,
                isLoading: false
            }));
            
            // Select initial version if provided
            if (initialVersion && versions.length > 0) {
                const version = versions.find(v => v.version === initialVersion);
                if (version) {
                    await selectVersion(version);
                }
            }
            
        } catch (error) {
            setState(prev => ({
                ...prev,
                error: error.message || 'Failed to load version history',
                isLoading: false
            }));
        }
    }, [historyService, initialVersion, filteredVersions.length, state.itemsPerPage]);

    // Select a version for detailed view
    const selectVersion = useCallback(async (version: IVersionSnapshot) => {
        setState(prev => ({ ...prev, isLoading: true, error: null }));
        
        try {
            // Load operations for this version
            const operations = await historyService.getOperationLog({
                fromVersion: Math.max(1, version.version - 10),
                toVersion: version.version
            });
            
            setState(prev => ({
                ...prev,
                selectedVersion: version,
                operations,
                isLoading: false
            }));
            
        } catch (error) {
            setState(prev => ({
                ...prev,
                error: error.message || 'Failed to load version details',
                isLoading: false
            }));
        }
    }, [historyService]);

    // Toggle version comparison mode
    const toggleComparison = useCallback((version: IVersionSnapshot) => {
        setState(prev => {
            const { versionSelection } = prev;
            
            if (!versionSelection.isComparing) {
                // Start comparison mode
                return {
                    ...prev,
                    versionSelection: {
                        fromVersion: version.version,
                        toVersion: null,
                        isComparing: true
                    }
                };
            } else if (versionSelection.fromVersion === version.version) {
                // Cancel comparison
                return {
                    ...prev,
                    versionSelection: {
                        fromVersion: null,
                        toVersion: null,
                        isComparing: false
                    }
                };
            } else if (!versionSelection.toVersion) {
                // Select second version for comparison
                return {
                    ...prev,
                    versionSelection: {
                        ...versionSelection,
                        toVersion: version.version
                    }
                };
            } else {
                // Replace second version
                return {
                    ...prev,
                    versionSelection: {
                        ...versionSelection,
                        toVersion: version.version
                    }
                };
            }
        });
    }, []);

    // Compare two versions
    const compareVersions = useCallback(async (fromVersion: number, toVersion: number) => {
        setState(prev => ({ ...prev, isLoading: true, error: null }));
        
        try {
            const diff = await historyService.getDiff(fromVersion, toVersion);
            
            setState(prev => ({
                ...prev,
                operations: diff.operations,
                isLoading: false
            }));
            
        } catch (error) {
            setState(prev => ({
                ...prev,
                error: error.message || 'Failed to compare versions',
                isLoading: false
            }));
        }
    }, [historyService]);

    // Rollback to a specific version
    const rollbackToVersion = useCallback(async (version: IVersionSnapshot) => {
        const result = await showDialog({
            title: trans.__('Rollback to Version %1', version.version.toString()),
            body: trans.__(
                'Are you sure you want to rollback to version %1? This will revert all changes made after this version. This action cannot be undone.',
                version.version.toString()
            ),
            buttons: [
                Dialog.cancelButton({ label: trans.__('Cancel') }),
                Dialog.warnButton({ label: trans.__('Rollback') })
            ]
        });
        
        if (result.button.accept) {
            setState(prev => ({ ...prev, isLoading: true, error: null }));
            
            try {
                await historyService.rollbackToVersion(version.version, {
                    createCheckpoint: true,
                    preserveAfter: false
                });
                
                // Force refresh the document
                await collaborationProvider.forceSynchronization();
                
                // Reload history
                await loadVersionHistory();
                
                setState(prev => ({ ...prev, isLoading: false }));
                
            } catch (error) {
                setState(prev => ({
                    ...prev,
                    error: error.message || 'Failed to rollback to version',
                    isLoading: false
                }));
            }
        }
    }, [trans, historyService, collaborationProvider, loadVersionHistory]);

    // Generate shareable URL for a version
    const generateVersionURL = useCallback((version: IVersionSnapshot) => {
        const currentURL = new URL(window.location.href);
        currentURL.searchParams.set('version', version.version.toString());
        currentURL.searchParams.set('snapshot', version.snapshotId);
        return currentURL.toString();
    }, []);

    // Copy version URL to clipboard
    const copyVersionURL = useCallback(async (version: IVersionSnapshot) => {
        try {
            const url = generateVersionURL(version);
            await navigator.clipboard.writeText(url);
            
            // Show success notification (could be enhanced with proper toast)
            console.log('Version URL copied to clipboard:', url);
            
        } catch (error) {
            console.error('Failed to copy version URL:', error);
        }
    }, [generateVersionURL]);

    // Update diff configuration
    const updateDiffConfig = useCallback((updates: Partial<IDiffViewConfig>) => {
        setState(prev => ({
            ...prev,
            diffConfig: { ...prev.diffConfig, ...updates }
        }));
    }, []);

    // Update search and filters
    const updateSearch = useCallback((query: string) => {
        setState(prev => ({
            ...prev,
            searchQuery: query,
            currentPage: 1
        }));
    }, []);

    const updateFilter = useCallback((filterUpdates: Partial<typeof DEFAULT_STATE.filterBy>) => {
        setState(prev => ({
            ...prev,
            filterBy: { ...prev.filterBy, ...filterUpdates },
            currentPage: 1
        }));
    }, []);

    // Handle page changes
    const changePage = useCallback((page: number) => {
        setState(prev => ({ ...prev, currentPage: page }));
    }, []);

    // Initialize component
    useEffect(() => {
        loadVersionHistory();
    }, [loadVersionHistory]);

    // Listen for history service events
    useEffect(() => {
        const onSnapshotCreated = () => {
            loadVersionHistory();
        };

        const onRollbackCompleted = () => {
            loadVersionHistory();
        };

        // Connect to history service events
        if (historyService.events) {
            historyService.events.snapshotCreated.connect(onSnapshotCreated);
            historyService.events.rollbackCompleted.connect(onRollbackCompleted);
        }

        return () => {
            // Disconnect events
            if (historyService.events) {
                historyService.events.snapshotCreated.disconnect(onSnapshotCreated);
                historyService.events.rollbackCompleted.disconnect(onRollbackCompleted);
            }
        };
    }, [historyService, loadVersionHistory]);

    // Render version timeline
    const renderVersionTimeline = () => (
        <div className="jp-HistoryViewer-timeline">
            <div className="jp-HistoryViewer-timeline-header">
                <h3>{trans.__('Version Timeline')}</h3>
                <div className="jp-HistoryViewer-search">
                    <input
                        type="text"
                        placeholder={trans.__('Search versions...')}
                        value={state.searchQuery}
                        onChange={(e) => updateSearch(e.target.value)}
                        className="jp-HistoryViewer-search-input"
                    />
                </div>
            </div>
            
            <div className="jp-HistoryViewer-filters">
                <select
                    value={state.filterBy.contributor || ''}
                    onChange={(e) => updateFilter({ contributor: e.target.value || null })}
                    className="jp-HistoryViewer-filter-select"
                >
                    <option value="">{trans.__('All Contributors')}</option>
                    {[...new Set(state.versions.map(v => v.contributorId))].map(contributor => (
                        <option key={contributor} value={contributor}>
                            {contributor}
                        </option>
                    ))}
                </select>
                
                <button
                    onClick={() => toggleComparison(state.selectedVersion!)}
                    disabled={!state.selectedVersion}
                    className={`jp-HistoryViewer-compare-btn ${state.versionSelection.isComparing ? 'active' : ''}`}
                >
                    {state.versionSelection.isComparing ? 
                        trans.__('Cancel Compare') : 
                        trans.__('Compare Versions')
                    }
                </button>
            </div>
            
            <div className="jp-HistoryViewer-version-list">
                {paginatedVersions.map((version) => (
                    <div
                        key={version.snapshotId}
                        className={`jp-HistoryViewer-version-item ${
                            state.selectedVersion?.snapshotId === version.snapshotId ? 'selected' : ''
                        } ${
                            state.versionSelection.fromVersion === version.version || 
                            state.versionSelection.toVersion === version.version ? 'comparing' : ''
                        }`}
                        onClick={() => selectVersion(version)}
                    >
                        <div className="jp-HistoryViewer-version-header">
                            <span className="jp-HistoryViewer-version-number">
                                {trans.__('Version %1', version.version.toString())}
                            </span>
                            <span className="jp-HistoryViewer-version-time">
                                {HistoryUtils.getSnapshotAge(version)}
                            </span>
                        </div>
                        
                        <div className="jp-HistoryViewer-version-details">
                            <div className="jp-HistoryViewer-version-contributor">
                                {trans.__('by %1', version.contributorId)}
                            </div>
                            <div className="jp-HistoryViewer-version-summary">
                                {version.changeSummary}
                            </div>
                            <div className="jp-HistoryViewer-version-size">
                                {(version.snapshotSizeBytes / 1024).toFixed(1)} KB
                            </div>
                        </div>
                        
                        <div className="jp-HistoryViewer-version-actions">
                            {state.versionSelection.isComparing && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        toggleComparison(version);
                                    }}
                                    className="jp-HistoryViewer-action-btn"
                                >
                                    {state.versionSelection.fromVersion === version.version ? 
                                        trans.__('From') :
                                        state.versionSelection.toVersion === version.version ?
                                        trans.__('To') :
                                        trans.__('Select')
                                    }
                                </button>
                            )}
                            
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    copyVersionURL(version);
                                }}
                                className="jp-HistoryViewer-action-btn"
                                title={trans.__('Copy Version URL')}
                            >
                                📋
                            </button>
                            
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    rollbackToVersion(version);
                                }}
                                className="jp-HistoryViewer-action-btn jp-HistoryViewer-rollback-btn"
                                title={trans.__('Rollback to this version')}
                            >
                                🔄
                            </button>
                        </div>
                    </div>
                ))}
            </div>
            
            {/* Pagination */}
            {state.totalPages > 1 && (
                <div className="jp-HistoryViewer-pagination">
                    <button
                        onClick={() => changePage(state.currentPage - 1)}
                        disabled={state.currentPage === 1}
                        className="jp-HistoryViewer-pagination-btn"
                    >
                        {trans.__('Previous')}
                    </button>
                    
                    <span className="jp-HistoryViewer-pagination-info">
                        {trans.__('Page %1 of %2', state.currentPage.toString(), state.totalPages.toString())}
                    </span>
                    
                    <button
                        onClick={() => changePage(state.currentPage + 1)}
                        disabled={state.currentPage === state.totalPages}
                        className="jp-HistoryViewer-pagination-btn"
                    >
                        {trans.__('Next')}
                    </button>
                </div>
            )}
        </div>
    );

    // Render version comparison view
    const renderVersionComparison = () => {
        const { fromVersion, toVersion } = state.versionSelection;
        
        if (!fromVersion || !toVersion) {
            return (
                <div className="jp-HistoryViewer-comparison-placeholder">
                    <p>{trans.__('Select two versions to compare')}</p>
                </div>
            );
        }

        return (
            <div className="jp-HistoryViewer-comparison">
                <div className="jp-HistoryViewer-comparison-header">
                    <h3>
                        {trans.__('Comparing Version %1 to %2', fromVersion.toString(), toVersion.toString())}
                    </h3>
                    
                    <div className="jp-HistoryViewer-diff-controls">
                        <label>
                            <input
                                type="radio"
                                name="diffMode"
                                value="side-by-side"
                                checked={state.diffConfig.mode === 'side-by-side'}
                                onChange={() => updateDiffConfig({ mode: 'side-by-side' })}
                            />
                            {trans.__('Side by Side')}
                        </label>
                        
                        <label>
                            <input
                                type="radio"
                                name="diffMode"
                                value="inline"
                                checked={state.diffConfig.mode === 'inline'}
                                onChange={() => updateDiffConfig({ mode: 'inline' })}
                            />
                            {trans.__('Inline')}
                        </label>
                        
                        <label>
                            <input
                                type="checkbox"
                                checked={state.diffConfig.showLineNumbers}
                                onChange={(e) => updateDiffConfig({ showLineNumbers: e.target.checked })}
                            />
                            {trans.__('Line Numbers')}
                        </label>
                        
                        <button
                            onClick={() => compareVersions(fromVersion, toVersion)}
                            className="jp-HistoryViewer-compare-execute-btn"
                        >
                            {trans.__('Compare')}
                        </button>
                    </div>
                </div>
                
                <div className={`jp-HistoryViewer-diff-view ${state.diffConfig.mode}`}>
                    {renderDiffOperations()}
                </div>
            </div>
        );
    };

    // Render diff operations
    const renderDiffOperations = () => {
        if (state.operations.length === 0) {
            return (
                <div className="jp-HistoryViewer-no-changes">
                    <p>{trans.__('No changes found between selected versions')}</p>
                </div>
            );
        }

        const groupedOperations = state.operations.reduce((groups, op) => {
            const cellId = op.attribution.cellId || 'unknown';
            if (!groups[cellId]) {
                groups[cellId] = [];
            }
            groups[cellId].push(op);
            return groups;
        }, {} as Record<string, ICRDTOperation[]>);

        return (
            <div className="jp-HistoryViewer-operations">
                {Object.entries(groupedOperations).map(([cellId, operations]) => (
                    <div key={cellId} className="jp-HistoryViewer-cell-changes">
                        <h4>{trans.__('Cell %1', cellId)}</h4>
                        
                        {operations.map((operation) => (
                            <div
                                key={operation.operationId}
                                className={`jp-HistoryViewer-operation ${operation.attribution.changeType}`}
                            >
                                <div className="jp-HistoryViewer-operation-header">
                                    <span className="jp-HistoryViewer-operation-type">
                                        {operation.attribution.changeType}
                                    </span>
                                    <span className="jp-HistoryViewer-operation-user">
                                        {operation.userId}
                                    </span>
                                    <span className="jp-HistoryViewer-operation-time">
                                        {operation.timestamp.toLocaleString()}
                                    </span>
                                </div>
                                
                                {operation.attribution.lineNumber && (
                                    <div className="jp-HistoryViewer-operation-location">
                                        {trans.__('Line %1', operation.attribution.lineNumber.toString())}
                                        {operation.attribution.characterOffset && 
                                            `, ${trans.__('Column %1', operation.attribution.characterOffset.toString())}`
                                        }
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        );
    };

    // Render version details panel
    const renderVersionDetails = () => {
        if (!state.selectedVersion) {
            return (
                <div className="jp-HistoryViewer-details-placeholder">
                    <p>{trans.__('Select a version to view details')}</p>
                </div>
            );
        }

        const version = state.selectedVersion;
        
        return (
            <div className="jp-HistoryViewer-details">
                <div className="jp-HistoryViewer-details-header">
                    <h3>{trans.__('Version %1 Details', version.version.toString())}</h3>
                </div>
                
                <div className="jp-HistoryViewer-details-content">
                    <div className="jp-HistoryViewer-detail-row">
                        <strong>{trans.__('Snapshot ID:')}</strong>
                        <span>{version.snapshotId}</span>
                    </div>
                    
                    <div className="jp-HistoryViewer-detail-row">
                        <strong>{trans.__('Contributor:')}</strong>
                        <span>{version.contributorId}</span>
                    </div>
                    
                    <div className="jp-HistoryViewer-detail-row">
                        <strong>{trans.__('Timestamp:')}</strong>
                        <span>{version.timestamp.toLocaleString()}</span>
                    </div>
                    
                    <div className="jp-HistoryViewer-detail-row">
                        <strong>{trans.__('Size:')}</strong>
                        <span>{(version.snapshotSizeBytes / 1024).toFixed(1)} KB</span>
                    </div>
                    
                    <div className="jp-HistoryViewer-detail-row">
                        <strong>{trans.__('Storage:')}</strong>
                        <span>{version.storageBackend}</span>
                    </div>
                    
                    <div className="jp-HistoryViewer-detail-row">
                        <strong>{trans.__('Summary:')}</strong>
                        <span>{version.changeSummary}</span>
                    </div>
                    
                    {version.metadata && Object.keys(version.metadata).length > 0 && (
                        <div className="jp-HistoryViewer-metadata">
                            <strong>{trans.__('Metadata:')}</strong>
                            <pre>{JSON.stringify(version.metadata, null, 2)}</pre>
                        </div>
                    )}
                </div>
                
                <div className="jp-HistoryViewer-details-actions">
                    <button
                        onClick={() => copyVersionURL(version)}
                        className="jp-HistoryViewer-details-btn"
                    >
                        {trans.__('Copy Version URL')}
                    </button>
                    
                    <button
                        onClick={() => rollbackToVersion(version)}
                        className="jp-HistoryViewer-details-btn jp-HistoryViewer-rollback-btn"
                    >
                        {trans.__('Rollback to This Version')}
                    </button>
                </div>
            </div>
        );
    };

    // Main render
    return (
        <div className="jp-HistoryViewer">
            <div className="jp-HistoryViewer-header">
                <h2>{trans.__('Document History - %1', collaborationProvider.documentId)}</h2>
                <button
                    onClick={onClose}
                    className="jp-HistoryViewer-close-btn"
                    aria-label={trans.__('Close History Viewer')}
                >
                    ✕
                </button>
            </div>
            
            {state.error && (
                <div className="jp-HistoryViewer-error">
                    <p>{state.error}</p>
                    <button
                        onClick={() => setState(prev => ({ ...prev, error: null }))}
                        className="jp-HistoryViewer-error-dismiss"
                    >
                        {trans.__('Dismiss')}
                    </button>
                </div>
            )}
            
            {state.isLoading && (
                <div className="jp-HistoryViewer-loading">
                    <Spinner />
                    <p>{trans.__('Loading version history...')}</p>
                </div>
            )}
            
            <div className="jp-HistoryViewer-content">
                <div className="jp-HistoryViewer-sidebar">
                    {renderVersionTimeline()}
                </div>
                
                <div className="jp-HistoryViewer-main">
                    {state.versionSelection.isComparing ? 
                        renderVersionComparison() : 
                        renderVersionDetails()
                    }
                </div>
            </div>
        </div>
    );
};

/**
 * A namespace for HistoryViewerComponent static methods.
 */
export namespace HistoryViewerComponent {
    /**
     * Create a new HistoryViewer modal dialog
     * 
     * @param options - Configuration options for the history viewer
     * @returns Promise that resolves when dialog is closed
     */
    export async function showDialog(options: {
        collaborationProvider: ICollaborationProvider;
        historyService: IHistoryService;
        translator: ITranslator;
        initialVersion?: number;
    }): Promise<void> {
        const { collaborationProvider, historyService, translator, initialVersion } = options;
        
        return new Promise<void>((resolve) => {
            const dialog = new Dialog({
                title: translator.load('notebook').__('Document History'),
                body: ReactWidget.create(
                    <HistoryViewer
                        collaborationProvider={collaborationProvider}
                        historyService={historyService}
                        translator={translator}
                        initialVersion={initialVersion}
                        onClose={() => {
                            dialog.resolve();
                            resolve();
                        }}
                    />
                ),
                buttons: [],
                hasClose: true,
                focusNodeSelector: '.jp-HistoryViewer-search-input'
            });
            
            dialog.launch();
        });
    }
    
    /**
     * Create a new HistoryViewer widget
     * 
     * @param options - Configuration options for the history viewer
     * @returns ReactWidget containing the HistoryViewer component
     */
    export function createWidget(options: {
        collaborationProvider: ICollaborationProvider;
        historyService: IHistoryService;
        translator: ITranslator;
        onClose?: () => void;
        initialVersion?: number;
    }): ReactWidget {
        const { collaborationProvider, historyService, translator, onClose, initialVersion } = options;
        
        return ReactWidget.create(
            <HistoryViewer
                collaborationProvider={collaborationProvider}
                historyService={historyService}
                translator={translator}
                onClose={onClose || (() => {})}
                initialVersion={initialVersion}
            />
        );
    }
}

export { HistoryViewer };