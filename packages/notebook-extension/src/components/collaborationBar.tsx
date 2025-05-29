import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/ui-components';
import { INotebookShell } from '@jupyter-notebook/application';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { INotebookModel } from '@jupyterlab/notebook';
import { Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';
import { Message } from '@lumino/messaging';

// Import collaboration modules
import { YjsNotebookProvider } from '../../../notebook/src/collab/provider';
import { IAwarenessProvider, UserInfo, PresenceState } from '../../../notebook/src/collab/awareness';
import { IPermissionsProvider, UserRole, PermissionLevel } from '../../../notebook/src/collab/permissions';

/**
 * Interface for collaboration status information
 */
interface ICollaborationStatus {
  isConnected: boolean;
  syncState: 'syncing' | 'synced' | 'offline' | 'error' | 'initializing';
  lastSyncTime: Date | null;
  connectionQuality: 'excellent' | 'good' | 'poor' | 'disconnected';
  conflictCount: number;
  retryCount: number;
  maxRetries: number;
}

/**
 * Interface for notification messages
 */
interface INotification {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: Date;
  autoHide?: boolean;
  duration?: number;
}

/**
 * Interface for activity feed items
 */
interface IActivityItem {
  id: string;
  timestamp: Date;
  user: UserInfo;
  action: 'joined' | 'left' | 'edit' | 'comment' | 'lock' | 'unlock' | 'permission_change';
  target?: string; // cell ID or notebook level
  description: string;
}

/**
 * Props interface for the CollaborationBar component
 */
interface ICollaborationBarProps {
  shell: INotebookShell;
  notebook?: INotebookModel;
  yjsProvider?: YjsNotebookProvider;
  awarenessProvider?: IAwarenessProvider;
  permissionsProvider?: IPermissionsProvider;
  onModeChange?: (mode: 'view' | 'edit') => void;
  onPermissionsOpen?: () => void;
  onHistoryOpen?: () => void;
}

/**
 * CollaborationBar component for displaying collaboration status and controls
 */
const CollaborationBar: React.FC<ICollaborationBarProps> = ({
  shell,
  notebook,
  yjsProvider,
  awarenessProvider,
  permissionsProvider,
  onModeChange,
  onPermissionsOpen,
  onHistoryOpen
}) => {
  // State management for collaboration features
  const [collaborationStatus, setCollaborationStatus] = useState<ICollaborationStatus>({
    isConnected: false,
    syncState: 'initializing',
    lastSyncTime: null,
    connectionQuality: 'disconnected',
    conflictCount: 0,
    retryCount: 0,
    maxRetries: 5
  });

  const [notifications, setNotifications] = useState<INotification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [connectedUsers, setConnectedUsers] = useState<UserInfo[]>([]);
  const [currentUser, setCurrentUser] = useState<UserInfo | null>(null);
  const [collaborationMode, setCollaborationMode] = useState<'view' | 'edit'>('edit');
  const [activityFeed, setActivityFeed] = useState<IActivityItem[]>([]);
  const [showActivityFeed, setShowActivityFeed] = useState(false);
  const [isShareMenuOpen, setIsShareMenuOpen] = useState(false);
  const [userPermissions, setUserPermissions] = useState<PermissionLevel>('view');

  /**
   * Add a notification to the system
   */
  const addNotification = useCallback((notification: Omit<INotification, 'id' | 'timestamp'>) => {
    const newNotification: INotification = {
      ...notification,
      id: `notification-${Date.now()}-${Math.random()}`,
      timestamp: new Date()
    };
    
    setNotifications(prev => [newNotification, ...prev].slice(0, 10)); // Keep only latest 10
    
    // Auto-hide notifications if specified
    if (notification.autoHide !== false) {
      const duration = notification.duration || (notification.type === 'error' ? 10000 : 5000);
      setTimeout(() => {
        setNotifications(prev => prev.filter(n => n.id !== newNotification.id));
      }, duration);
    }
  }, []);

  /**
   * Handle connection errors with retry logic
   */
  const handleConnectionError = useCallback((error: Error) => {
    setHasError(true);
    setErrorMessage(error.message);
    
    setCollaborationStatus(prev => {
      const newRetryCount = prev.retryCount + 1;
      const shouldRetry = newRetryCount < prev.maxRetries;
      
      if (shouldRetry) {
        addNotification({
          type: 'warning',
          message: `Connection failed. Retrying... (${newRetryCount}/${prev.maxRetries})`,
          autoHide: true
        });
        
        // Exponential backoff retry
        setTimeout(() => {
          if (yjsProvider) {
            yjsProvider.reconnect?.();
          }
        }, Math.min(1000 * Math.pow(2, newRetryCount), 30000));
      } else {
        addNotification({
          type: 'error',
          message: 'Failed to connect to collaboration service. Working in offline mode.',
          autoHide: false
        });
      }
      
      return {
        ...prev,
        isConnected: false,
        syncState: shouldRetry ? 'syncing' : 'error',
        connectionQuality: 'disconnected',
        retryCount: newRetryCount
      };
    });
  }, [yjsProvider, addNotification]);

  /**
   * Initialize collaboration providers and subscribe to events
   */
  useEffect(() => {
    if (!yjsProvider || !awarenessProvider) {
      setIsLoading(false);
      setHasError(true);
      setErrorMessage('Collaboration providers not available');
      addNotification({
        type: 'warning',
        message: 'Collaboration features are not available. Working in single-user mode.',
        autoHide: false
      });
      return;
    }

    setIsLoading(true);
    setHasError(false);
    setErrorMessage(null);

    // Subscribe to connection status changes
    const handleConnectionChange = (connected: boolean) => {
      setCollaborationStatus(prev => ({
        ...prev,
        isConnected: connected,
        syncState: connected ? 'synced' : 'offline',
        connectionQuality: connected ? 'excellent' : 'disconnected',
        lastSyncTime: connected ? new Date() : prev.lastSyncTime,
        retryCount: connected ? 0 : prev.retryCount // Reset retry count on successful connection
      }));

      if (connected) {
        setHasError(false);
        setErrorMessage(null);
        addNotification({
          type: 'success',
          message: 'Connected to collaboration service',
          autoHide: true,
          duration: 3000
        });
      } else {
        addNotification({
          type: 'warning',
          message: 'Lost connection to collaboration service',
          autoHide: true,
          duration: 5000
        });
      }
      
      setIsLoading(false);
    };

    // Subscribe to sync state changes
    const handleSyncStateChange = (state: 'syncing' | 'synced' | 'error') => {
      setCollaborationStatus(prev => ({
        ...prev,
        syncState: state,
        lastSyncTime: state === 'synced' ? new Date() : prev.lastSyncTime
      }));

      if (state === 'error') {
        addNotification({
          type: 'error',
          message: 'Synchronization error occurred. Some changes may not be saved.',
          autoHide: true,
          duration: 8000
        });
      } else if (state === 'synced' && prev.syncState === 'syncing') {
        // Only show success message when transitioning from syncing to synced
        addNotification({
          type: 'success',
          message: 'All changes synchronized',
          autoHide: true,
          duration: 2000
        });
      }
    };

    // Subscribe to user presence changes
    const handlePresenceChange = (users: UserInfo[], current: UserInfo | null) => {
      try {
        setConnectedUsers(users);
        setCurrentUser(current);
        
        // Add activity for user joins/leaves
        users.forEach(user => {
          const existingUser = connectedUsers.find(u => u.id === user.id);
          if (!existingUser && user.id !== current?.id) {
            addActivityItem({
              id: `join-${user.id}-${Date.now()}`,
              timestamp: new Date(),
              user,
              action: 'joined',
              description: `${user.name} joined the session`
            });
          }
        });

        // Detect users who left
        connectedUsers.forEach(user => {
          const stillConnected = users.find(u => u.id === user.id);
          if (!stillConnected && user.id !== current?.id) {
            addActivityItem({
              id: `leave-${user.id}-${Date.now()}`,
              timestamp: new Date(),
              user,
              action: 'left',
              description: `${user.name} left the session`
            });
          }
        });
      } catch (error) {
        console.error('Error handling presence change:', error);
        addNotification({
          type: 'error',
          message: 'Error updating user presence information',
          autoHide: true
        });
      }
    };

    // Subscribe to permission changes
    const handlePermissionChange = (permissions: PermissionLevel) => {
      setUserPermissions(permissions);
    };

    try {
      // Setup event listeners
      yjsProvider.connectionStateChanged.connect(handleConnectionChange);
      yjsProvider.syncStateChanged.connect(handleSyncStateChange);
      awarenessProvider.presenceChanged.connect(handlePresenceChange);
      
      if (permissionsProvider) {
        permissionsProvider.permissionsChanged.connect(handlePermissionChange);
      }

      // Add error handler for general collaboration errors
      if (yjsProvider.errorOccurred) {
        yjsProvider.errorOccurred.connect(handleConnectionError);
      }

      // Initialize current state
      setCollaborationStatus(prev => ({
        ...prev,
        isConnected: yjsProvider.isConnected || false,
        syncState: yjsProvider.syncState || 'initializing'
      }));

      if (awarenessProvider.currentUser) {
        setCurrentUser(awarenessProvider.currentUser);
      }

      setConnectedUsers(awarenessProvider.connectedUsers || []);
      
      // Mark initialization as complete
      setIsLoading(false);

    } catch (error) {
      console.error('Error initializing collaboration:', error);
      handleConnectionError(error instanceof Error ? error : new Error('Unknown initialization error'));
    }

    return () => {
      try {
        yjsProvider.connectionStateChanged.disconnect(handleConnectionChange);
        yjsProvider.syncStateChanged.disconnect(handleSyncStateChange);
        awarenessProvider.presenceChanged.disconnect(handlePresenceChange);
        
        if (permissionsProvider) {
          permissionsProvider.permissionsChanged.disconnect(handlePermissionChange);
        }

        if (yjsProvider.errorOccurred) {
          yjsProvider.errorOccurred.disconnect(handleConnectionError);
        }
      } catch (error) {
        console.error('Error during cleanup:', error);
      }
    };
  }, [yjsProvider, awarenessProvider, permissionsProvider, connectedUsers]);

  /**
   * Add an item to the activity feed
   */
  const addActivityItem = useCallback((item: IActivityItem) => {
    setActivityFeed(prev => [item, ...prev].slice(0, 50)); // Keep only latest 50 items
  }, []);

  /**
   * Handle collaboration mode toggle
   */
  const handleModeToggle = useCallback(() => {
    const newMode = collaborationMode === 'view' ? 'edit' : 'view';
    setCollaborationMode(newMode);
    onModeChange?.(newMode);
    
    if (currentUser) {
      addActivityItem({
        id: `mode-${Date.now()}`,
        timestamp: new Date(),
        user: currentUser,
        action: 'edit',
        description: `Switched to ${newMode} mode`
      });
    }
  }, [collaborationMode, onModeChange, currentUser, addActivityItem]);

  /**
   * Handle share menu toggle
   */
  const handleShareToggle = useCallback(() => {
    setIsShareMenuOpen(prev => !prev);
  }, []);

  /**
   * Handle permissions dialog opening
   */
  const handlePermissionsClick = useCallback(() => {
    setIsShareMenuOpen(false);
    onPermissionsOpen?.();
  }, [onPermissionsOpen]);

  /**
   * Generate share link with current permissions
   */
  const handleGenerateShareLink = useCallback(async () => {
    if (!permissionsProvider || !notebook) {
      addNotification({
        type: 'error',
        message: 'Share functionality not available',
        autoHide: true
      });
      return;
    }

    try {
      addNotification({
        type: 'info',
        message: 'Generating share link...',
        autoHide: true,
        duration: 2000
      });

      const shareUrl = await permissionsProvider.generateShareLink(
        notebook.path,
        'edit' // Default to edit permissions for share links
      );
      
      // Copy to clipboard
      await navigator.clipboard.writeText(shareUrl);
      
      addNotification({
        type: 'success',
        message: 'Share link copied to clipboard!',
        autoHide: true,
        duration: 4000
      });
      
      if (currentUser) {
        addActivityItem({
          id: `share-${Date.now()}`,
          timestamp: new Date(),
          user: currentUser,
          action: 'permission_change',
          description: 'Generated share link'
        });
      }
    } catch (error) {
      console.error('Failed to generate share link:', error);
      addNotification({
        type: 'error',
        message: `Failed to generate share link: ${error instanceof Error ? error.message : 'Unknown error'}`,
        autoHide: true,
        duration: 8000
      });
    }
  }, [permissionsProvider, notebook, currentUser, addActivityItem, addNotification]);

  /**
   * Render notification system
   */
  const renderNotifications = useCallback(() => {
    if (notifications.length === 0) {
      return null;
    }

    return (
      <div className="jp-Collab-notifications">
        {notifications.slice(0, 3).map(notification => (
          <div
            key={notification.id}
            className={`jp-Collab-notification jp-Collab-notification-${notification.type}`}
            onClick={() => setNotifications(prev => prev.filter(n => n.id !== notification.id))}
          >
            <div className="jp-Collab-notification-content">
              <div className="jp-Collab-notification-icon">
                {notification.type === 'error' && '❌'}
                {notification.type === 'warning' && '⚠️'}
                {notification.type === 'success' && '✅'}
                {notification.type === 'info' && 'ℹ️'}
              </div>
              <div className="jp-Collab-notification-message">{notification.message}</div>
            </div>
            <button
              className="jp-Collab-notification-close"
              onClick={(e) => {
                e.stopPropagation();
                setNotifications(prev => prev.filter(n => n.id !== notification.id));
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    );
  }, [notifications]);

  /**
   * Get connection status icon and color
   */
  const getConnectionStatus = useMemo(() => {
    const { isConnected, syncState, connectionQuality } = collaborationStatus;
    
    if (!isConnected) {
      return { icon: '⚫', color: '#666', tooltip: 'Disconnected - Working offline' };
    }
    
    switch (syncState) {
      case 'syncing':
        return { icon: '🟡', color: '#f59e0b', tooltip: 'Syncing changes...' };
      case 'synced':
        return connectionQuality === 'excellent' 
          ? { icon: '🟢', color: '#10b981', tooltip: 'Connected - All changes synced' }
          : { icon: '🟡', color: '#f59e0b', tooltip: 'Connected - Slow connection' };
      case 'error':
        return { icon: '🔴', color: '#ef4444', tooltip: 'Sync error - Some changes may be lost' };
      default:
        return { icon: '⚫', color: '#666', tooltip: 'Connection status unknown' };
    }
  }, [collaborationStatus]);

  /**
   * Format last sync time for display
   */
  const formatLastSync = useMemo(() => {
    if (!collaborationStatus.lastSyncTime) {
      return 'Never';
    }
    
    const now = new Date();
    const diff = now.getTime() - collaborationStatus.lastSyncTime.getTime();
    const minutes = Math.floor(diff / 60000);
    
    if (minutes < 1) {
      return 'Just now';
    } else if (minutes < 60) {
      return `${minutes}m ago`;
    } else {
      const hours = Math.floor(minutes / 60);
      return `${hours}h ago`;
    }
  }, [collaborationStatus.lastSyncTime]);

  /**
   * Render user avatar
   */
  const renderUserAvatar = useCallback((user: UserInfo, size: 'small' | 'medium' = 'small') => {
    const sizeClass = size === 'small' ? 'jp-Collab-avatar-small' : 'jp-Collab-avatar-medium';
    const initials = user.name.split(' ').map(n => n[0]).join('').toUpperCase();
    
    return (
      <div
        key={user.id}
        className={`jp-Collab-avatar ${sizeClass}`}
        style={{ 
          backgroundColor: user.color || '#666',
          borderColor: user.isActive ? '#10b981' : 'transparent'
        }}
        title={`${user.name} (${user.role})`}
      >
        {user.avatar ? (
          <img src={user.avatar} alt={user.name} />
        ) : (
          <span className="jp-Collab-avatar-initials">{initials}</span>
        )}
        {user.isActive && <div className="jp-Collab-avatar-active-indicator" />}
      </div>
    );
  }, []);

  /**
   * Render activity feed
   */
  const renderActivityFeed = useCallback(() => {
    if (!showActivityFeed || activityFeed.length === 0) {
      return null;
    }

    return (
      <div className="jp-Collab-activity-feed">
        <div className="jp-Collab-activity-header">
          <span>Recent Activity</span>
          <button
            className="jp-Collab-activity-close"
            onClick={() => setShowActivityFeed(false)}
            title="Close activity feed"
          >
            ×
          </button>
        </div>
        <div className="jp-Collab-activity-list">
          {activityFeed.slice(0, 10).map(item => (
            <div key={item.id} className="jp-Collab-activity-item">
              {renderUserAvatar(item.user, 'small')}
              <div className="jp-Collab-activity-content">
                <div className="jp-Collab-activity-description">{item.description}</div>
                <div className="jp-Collab-activity-time">
                  {item.timestamp.toLocaleTimeString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }, [showActivityFeed, activityFeed, renderUserAvatar]);

  /**
   * Render share menu
   */
  const renderShareMenu = useCallback(() => {
    if (!isShareMenuOpen) {
      return null;
    }

    return (
      <div className="jp-Collab-share-menu">
        <div className="jp-Collab-share-header">
          <span>Share Notebook</span>
          <button
            className="jp-Collab-share-close"
            onClick={() => setIsShareMenuOpen(false)}
            title="Close share menu"
          >
            ×
          </button>
        </div>
        <div className="jp-Collab-share-content">
          <button
            className="jp-Collab-share-button"
            onClick={handleGenerateShareLink}
            title="Generate shareable link"
          >
            📋 Copy Share Link
          </button>
          <button
            className="jp-Collab-share-button"
            onClick={handlePermissionsClick}
            title="Manage permissions"
          >
            🔒 Manage Permissions
          </button>
          <div className="jp-Collab-share-info">
            <div>Current Permission: <strong>{userPermissions}</strong></div>
            <div>Connected Users: <strong>{connectedUsers.length}</strong></div>
          </div>
        </div>
      </div>
    );
  }, [isShareMenuOpen, handleGenerateShareLink, handlePermissionsClick, userPermissions, connectedUsers.length]);

  // Show loading state during initialization
  if (isLoading) {
    return (
      <div className="jp-Collab-bar jp-Collab-loading">
        <div className="jp-Collab-loading-indicator">
          <span>⏳</span>
          <span>Initializing collaboration...</span>
        </div>
      </div>
    );
  }

  // Show error state if collaboration is not available
  if (!yjsProvider || !awarenessProvider || hasError) {
    return (
      <div className="jp-Collab-bar jp-Collab-error">
        <div className="jp-Collab-error-indicator">
          <span>⚠️</span>
          <span>{errorMessage || 'Collaboration unavailable - working in single-user mode'}</span>
        </div>
        {renderNotifications()}
      </div>
    );
  }

  return (
    <div className="jp-Collab-bar">
      {/* Notifications */}
      {renderNotifications()}
      {/* Connection Status */}
      <div 
        className="jp-Collab-status-section"
        role="status"
        aria-label="Collaboration connection status"
      >
        <div 
          className="jp-Collab-status-indicator"
          title={getConnectionStatus.tooltip}
          style={{ color: getConnectionStatus.color }}
          aria-label={getConnectionStatus.tooltip}
        >
          {getConnectionStatus.icon}
        </div>
        <div className="jp-Collab-status-text">
          <div className="jp-Collab-status-primary">{collaborationStatus.syncState}</div>
          <div className="jp-Collab-status-secondary">Last sync: {formatLastSync}</div>
        </div>
      </div>

      {/* Connected Users */}
      <div 
        className="jp-Collab-users-section"
        role="group"
        aria-label="Connected users"
      >
        <div className="jp-Collab-users-avatars" role="list">
          {connectedUsers.slice(0, 5).map(user => renderUserAvatar(user))}
          {connectedUsers.length > 5 && (
            <div 
              className="jp-Collab-users-more" 
              title={`+${connectedUsers.length - 5} more users`}
              aria-label={`${connectedUsers.length - 5} additional users connected`}
            >
              +{connectedUsers.length - 5}
            </div>
          )}
        </div>
        <div 
          className="jp-Collab-users-count"
          aria-live="polite"
          aria-label={`${connectedUsers.length} user${connectedUsers.length !== 1 ? 's' : ''} connected`}
        >
          {connectedUsers.length} user{connectedUsers.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Collaboration Mode Toggle */}
      <div className="jp-Collab-mode-section">
        <button
          className={`jp-Collab-mode-toggle ${collaborationMode === 'edit' ? 'jp-Collab-mode-edit' : 'jp-Collab-mode-view'}`}
          onClick={handleModeToggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleModeToggle();
            }
          }}
          disabled={userPermissions === 'view'}
          title={`Switch to ${collaborationMode === 'view' ? 'edit' : 'view'} mode`}
          aria-label={`Current mode: ${collaborationMode}. Click to switch to ${collaborationMode === 'view' ? 'edit' : 'view'} mode`}
          aria-pressed={collaborationMode === 'edit'}
        >
          {collaborationMode === 'edit' ? '✏️ Edit' : '👁️ View'}
        </button>
      </div>

      {/* Activity Feed Toggle */}
      <div className="jp-Collab-activity-section">
        <button
          className={`jp-Collab-activity-toggle ${showActivityFeed ? 'jp-Collab-active' : ''}`}
          onClick={() => setShowActivityFeed(prev => !prev)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setShowActivityFeed(prev => !prev);
            } else if (e.key === 'Escape' && showActivityFeed) {
              setShowActivityFeed(false);
            }
          }}
          title="Show recent activity"
          aria-label={`Activity feed. ${activityFeed.length} recent activities. ${showActivityFeed ? 'Press Escape to close' : 'Click to open'}`}
          aria-expanded={showActivityFeed}
          aria-haspopup="true"
        >
          📝 Activity
          {activityFeed.length > 0 && (
            <span 
              className="jp-Collab-activity-badge"
              aria-label={`${activityFeed.length} unread activities`}
            >
              {activityFeed.length}
            </span>
          )}
        </button>
        {renderActivityFeed()}
      </div>

      {/* Share Controls */}
      <div className="jp-Collab-share-section">
        <button
          className={`jp-Collab-share-toggle ${isShareMenuOpen ? 'jp-Collab-active' : ''}`}
          onClick={handleShareToggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleShareToggle();
            } else if (e.key === 'Escape' && isShareMenuOpen) {
              setIsShareMenuOpen(false);
            }
          }}
          title="Share notebook"
          aria-label={`Share notebook. ${isShareMenuOpen ? 'Press Escape to close menu' : 'Click to open share options'}`}
          aria-expanded={isShareMenuOpen}
          aria-haspopup="true"
        >
          📤 Share
        </button>
        {renderShareMenu()}
      </div>

      {/* History Access */}
      <div className="jp-Collab-history-section">
        <button
          className="jp-Collab-history-toggle"
          onClick={onHistoryOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onHistoryOpen?.();
            }
          }}
          title="View change history"
          aria-label="Open change history viewer"
        >
          🕒 History
        </button>
      </div>
    </div>
  );
};

/**
 * Widget wrapper for the CollaborationBar component
 */
export class CollaborationBarWidget extends ReactWidget {
  private _shell: INotebookShell;
  private _notebook?: INotebookModel;
  private _yjsProvider?: YjsNotebookProvider;
  private _awarenessProvider?: IAwarenessProvider;
  private _permissionsProvider?: IPermissionsProvider;
  private _modeChanged = new Signal<this, 'view' | 'edit'>(this);
  private _permissionsRequested = new Signal<this, void>(this);
  private _historyRequested = new Signal<this, void>(this);

  constructor(options: {
    shell: INotebookShell;
    notebook?: INotebookModel;
    yjsProvider?: YjsNotebookProvider;
    awarenessProvider?: IAwarenessProvider;
    permissionsProvider?: IPermissionsProvider;
  }) {
    super();
    this._shell = options.shell;
    this._notebook = options.notebook;
    this._yjsProvider = options.yjsProvider;
    this._awarenessProvider = options.awarenessProvider;
    this._permissionsProvider = options.permissionsProvider;
    this.addClass('jp-Collab-BarWidget');
  }

  /**
   * Signal emitted when collaboration mode changes
   */
  get modeChanged(): ISignal<this, 'view' | 'edit'> {
    return this._modeChanged;
  }

  /**
   * Signal emitted when permissions dialog is requested
   */
  get permissionsRequested(): ISignal<this, void> {
    return this._permissionsRequested;
  }

  /**
   * Signal emitted when history viewer is requested
   */
  get historyRequested(): ISignal<this, void> {
    return this._historyRequested;
  }

  /**
   * Update the notebook model
   */
  setNotebook(notebook: INotebookModel | undefined): void {
    this._notebook = notebook;
    this.update();
  }

  /**
   * Update the YjsNotebookProvider
   */
  setYjsProvider(provider: YjsNotebookProvider | undefined): void {
    this._yjsProvider = provider;
    this.update();
  }

  /**
   * Update the awareness provider
   */
  setAwarenessProvider(provider: IAwarenessProvider | undefined): void {
    this._awarenessProvider = provider;
    this.update();
  }

  /**
   * Update the permissions provider
   */
  setPermissionsProvider(provider: IPermissionsProvider | undefined): void {
    this._permissionsProvider = provider;
    this.update();
  }

  protected render(): JSX.Element {
    return (
      <CollaborationBar
        shell={this._shell}
        notebook={this._notebook}
        yjsProvider={this._yjsProvider}
        awarenessProvider={this._awarenessProvider}
        permissionsProvider={this._permissionsProvider}
        onModeChange={(mode) => this._modeChanged.emit(mode)}
        onPermissionsOpen={() => this._permissionsRequested.emit()}
        onHistoryOpen={() => this._historyRequested.emit()}
      />
    );
  }
}

/**
 * Token for the CollaborationBar service
 */
export const ICollaborationBar = new Token<ICollaborationBar>(
  '@jupyter-notebook/collaboration-bar:ICollaborationBar'
);

/**
 * Interface for the CollaborationBar service
 */
export interface ICollaborationBar {
  /**
   * The collaboration bar widget
   */
  readonly widget: CollaborationBarWidget;

  /**
   * Signal emitted when collaboration mode changes
   */
  readonly modeChanged: ISignal<CollaborationBarWidget, 'view' | 'edit'>;

  /**
   * Signal emitted when permissions dialog is requested
   */
  readonly permissionsRequested: ISignal<CollaborationBarWidget, void>;

  /**
   * Signal emitted when history viewer is requested
   */
  readonly historyRequested: ISignal<CollaborationBarWidget, void>;
}

export default CollaborationBar;

/**
 * CSS Styles for the CollaborationBar component
 * These styles should be included in the extension's CSS bundle
 */
export const COLLABORATION_BAR_CSS = `
/* Main collaboration bar container */
.jp-Collab-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  background: var(--jp-layout-color1);
  border-bottom: 1px solid var(--jp-border-color1);
  min-height: 40px;
  font-size: var(--jp-ui-font-size1);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  position: relative;
  z-index: 1000;
}

/* Status section */
.jp-Collab-status-section {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 120px;
}

.jp-Collab-status-indicator {
  font-size: 14px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.jp-Collab-status-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.jp-Collab-status-primary {
  font-weight: 500;
  color: var(--jp-ui-font-color1);
  text-transform: capitalize;
}

.jp-Collab-status-secondary {
  font-size: 11px;
  color: var(--jp-ui-font-color2);
}

/* Users section */
.jp-Collab-users-section {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 100px;
}

.jp-Collab-users-avatars {
  display: flex;
  align-items: center;
  gap: -4px; /* Overlap avatars slightly */
}

.jp-Collab-avatar {
  border-radius: 50%;
  border: 2px solid transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  position: relative;
  transition: transform 0.2s ease;
}

.jp-Collab-avatar:hover {
  transform: scale(1.1);
  z-index: 10;
}

.jp-Collab-avatar-small {
  width: 24px;
  height: 24px;
  font-size: 10px;
}

.jp-Collab-avatar-medium {
  width: 32px;
  height: 32px;
  font-size: 12px;
}

.jp-Collab-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.jp-Collab-avatar-active-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 8px;
  height: 8px;
  background: #10b981;
  border: 2px solid white;
  border-radius: 50%;
}

.jp-Collab-users-more {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--jp-ui-font-color2);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
}

.jp-Collab-users-count {
  font-size: 11px;
  color: var(--jp-ui-font-color2);
  white-space: nowrap;
}

/* Mode section */
.jp-Collab-mode-section {
  display: flex;
  align-items: center;
}

.jp-Collab-mode-toggle {
  padding: 4px 12px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
  min-width: 60px;
}

.jp-Collab-mode-toggle:hover:not(:disabled) {
  background: var(--jp-layout-color2);
  border-color: var(--jp-brand-color1);
}

.jp-Collab-mode-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.jp-Collab-mode-edit {
  border-color: var(--jp-brand-color1);
  background: var(--jp-brand-color1);
  color: white;
}

.jp-Collab-mode-view {
  border-color: var(--jp-warn-color1);
  background: var(--jp-warn-color1);
  color: white;
}

/* Activity section */
.jp-Collab-activity-section {
  position: relative;
}

.jp-Collab-activity-toggle {
  padding: 4px 12px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
  position: relative;
}

.jp-Collab-activity-toggle:hover {
  background: var(--jp-layout-color2);
  border-color: var(--jp-brand-color1);
}

.jp-Collab-activity-toggle.jp-Collab-active {
  background: var(--jp-brand-color1);
  color: white;
  border-color: var(--jp-brand-color1);
}

.jp-Collab-activity-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  background: var(--jp-error-color1);
  color: white;
  border-radius: 10px;
  font-size: 9px;
  padding: 2px 5px;
  min-width: 16px;
  text-align: center;
  line-height: 1;
}

.jp-Collab-activity-feed {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 8px;
  background: var(--jp-layout-color1);
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 300px;
  max-width: 400px;
  max-height: 300px;
  overflow: hidden;
  z-index: 1001;
}

.jp-Collab-activity-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--jp-border-color1);
  background: var(--jp-layout-color2);
  font-weight: 500;
}

.jp-Collab-activity-close {
  background: none;
  border: none;
  color: var(--jp-ui-font-color2);
  cursor: pointer;
  font-size: 16px;
  padding: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.jp-Collab-activity-close:hover {
  color: var(--jp-ui-font-color1);
}

.jp-Collab-activity-list {
  max-height: 250px;
  overflow-y: auto;
}

.jp-Collab-activity-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--jp-border-color2);
}

.jp-Collab-activity-item:last-child {
  border-bottom: none;
}

.jp-Collab-activity-content {
  flex: 1;
  min-width: 0;
}

.jp-Collab-activity-description {
  font-size: 12px;
  color: var(--jp-ui-font-color1);
  line-height: 1.3;
  margin-bottom: 2px;
}

.jp-Collab-activity-time {
  font-size: 10px;
  color: var(--jp-ui-font-color2);
}

/* Share section */
.jp-Collab-share-section {
  position: relative;
}

.jp-Collab-share-toggle {
  padding: 4px 12px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
}

.jp-Collab-share-toggle:hover {
  background: var(--jp-layout-color2);
  border-color: var(--jp-brand-color1);
}

.jp-Collab-share-toggle.jp-Collab-active {
  background: var(--jp-brand-color1);
  color: white;
  border-color: var(--jp-brand-color1);
}

.jp-Collab-share-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 8px;
  background: var(--jp-layout-color1);
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 250px;
  z-index: 1001;
}

.jp-Collab-share-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--jp-border-color1);
  background: var(--jp-layout-color2);
  font-weight: 500;
}

.jp-Collab-share-close {
  background: none;
  border: none;
  color: var(--jp-ui-font-color2);
  cursor: pointer;
  font-size: 16px;
  padding: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.jp-Collab-share-close:hover {
  color: var(--jp-ui-font-color1);
}

.jp-Collab-share-content {
  padding: 12px;
}

.jp-Collab-share-button {
  display: block;
  width: 100%;
  padding: 8px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition: all 0.2s ease;
}

.jp-Collab-share-button:hover {
  background: var(--jp-layout-color2);
  border-color: var(--jp-brand-color1);
}

.jp-Collab-share-button:last-of-type {
  margin-bottom: 12px;
}

.jp-Collab-share-info {
  border-top: 1px solid var(--jp-border-color2);
  padding-top: 8px;
  font-size: 11px;
  color: var(--jp-ui-font-color2);
}

.jp-Collab-share-info div {
  margin-bottom: 4px;
}

.jp-Collab-share-info strong {
  color: var(--jp-ui-font-color1);
}

/* History section */
.jp-Collab-history-section {
  display: flex;
  align-items: center;
}

.jp-Collab-history-toggle {
  padding: 4px 12px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
}

.jp-Collab-history-toggle:hover {
  background: var(--jp-layout-color2);
  border-color: var(--jp-brand-color1);
}

/* Widget wrapper */
.jp-Collab-BarWidget {
  flex-shrink: 0;
}

/* Loading state */
.jp-Collab-loading {
  justify-content: center;
  opacity: 0.8;
}

.jp-Collab-loading-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--jp-ui-font-color2);
}

.jp-Collab-loading-indicator span:first-child {
  animation: jp-Collab-spin 1s linear infinite;
}

@keyframes jp-Collab-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Error state */
.jp-Collab-error {
  justify-content: center;
  background: var(--jp-warn-color3);
  border-bottom-color: var(--jp-warn-color1);
}

.jp-Collab-error-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--jp-warn-color1);
}

/* Notifications */
.jp-Collab-notifications {
  position: fixed;
  top: 80px;
  right: 16px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 400px;
}

.jp-Collab-notification {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  cursor: pointer;
  transition: transform 0.2s ease, opacity 0.2s ease;
  animation: jp-Collab-slideIn 0.3s ease-out;
}

.jp-Collab-notification:hover {
  transform: translateX(-4px);
}

.jp-Collab-notification-info {
  background: var(--jp-info-color3);
  border-left: 4px solid var(--jp-info-color1);
  color: var(--jp-info-color1);
}

.jp-Collab-notification-success {
  background: var(--jp-success-color3);
  border-left: 4px solid var(--jp-success-color1);
  color: var(--jp-success-color1);
}

.jp-Collab-notification-warning {
  background: var(--jp-warn-color3);
  border-left: 4px solid var(--jp-warn-color1);
  color: var(--jp-warn-color1);
}

.jp-Collab-notification-error {
  background: var(--jp-error-color3);
  border-left: 4px solid var(--jp-error-color1);
  color: var(--jp-error-color1);
}

.jp-Collab-notification-content {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: 1;
}

.jp-Collab-notification-icon {
  font-size: 14px;
  flex-shrink: 0;
  margin-top: 1px;
}

.jp-Collab-notification-message {
  font-size: 12px;
  line-height: 1.4;
  flex: 1;
}

.jp-Collab-notification-close {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  padding: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  flex-shrink: 0;
}

.jp-Collab-notification-close:hover {
  opacity: 1;
}

@keyframes jp-Collab-slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

/* Responsive design */
@media (max-width: 768px) {
  .jp-Collab-bar {
    gap: 8px;
    padding: 6px 12px;
    flex-wrap: wrap;
  }
  
  .jp-Collab-status-text {
    display: none;
  }
  
  .jp-Collab-users-count {
    display: none;
  }
  
  .jp-Collab-activity-feed,
  .jp-Collab-share-menu {
    right: auto;
    left: 0;
    min-width: 280px;
  }
}

@media (max-width: 480px) {
  .jp-Collab-bar {
    gap: 4px;
    padding: 4px 8px;
  }
  
  .jp-Collab-mode-toggle,
  .jp-Collab-activity-toggle,
  .jp-Collab-share-toggle,
  .jp-Collab-history-toggle {
    padding: 4px 8px;
    font-size: 11px;
  }
  
  .jp-Collab-avatar-small {
    width: 20px;
    height: 20px;
    font-size: 9px;
  }
}

/* Dark theme support */
[data-jp-theme-light="false"] .jp-Collab-avatar-active-indicator {
  border-color: var(--jp-layout-color1);
}

[data-jp-theme-light="false"] .jp-Collab-activity-feed,
[data-jp-theme-light="false"] .jp-Collab-share-menu {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .jp-Collab-bar {
    border-bottom-width: 2px;
  }
  
  .jp-Collab-mode-toggle,
  .jp-Collab-activity-toggle,
  .jp-Collab-share-toggle,
  .jp-Collab-history-toggle {
    border-width: 2px;
  }
  
  .jp-Collab-avatar {
    border-width: 3px;
  }
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  .jp-Collab-avatar,
  .jp-Collab-mode-toggle,
  .jp-Collab-activity-toggle,
  .jp-Collab-share-toggle,
  .jp-Collab-history-toggle {
    transition: none;
  }
}
`;