/**
 * CollaborationBar component providing main collaboration toolbar
 * with session status, user activity feed, and access to all collaboration features.
 * 
 * This component implements Feature F-030 from the technical specification,
 * providing a centralized interface for collaboration features including:
 * - Real-time session status and participant count
 * - User presence avatars with activity indicators
 * - Quick access to collaboration tools (comments, history, permissions, locks)
 * - Activity feed with recent collaborative events
 * - Responsive design with accessibility support
 * 
 * @package @jupyter-notebook/notebook-extension
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { INotebookTracker } from '@jupyterlab/notebook';
import { JupyterFrontEnd } from '@jupyterlab/application';

// CSS classes for styling
const COLLABORATION_BAR_CLASS = 'jp-CollaborationBar';
const COLLABORATION_BAR_CONTAINER_CLASS = 'jp-CollaborationBar-container';
const COLLABORATION_STATUS_CLASS = 'jp-CollaborationBar-status';
const COLLABORATION_AVATARS_CLASS = 'jp-CollaborationBar-avatars';
const COLLABORATION_CONTROLS_CLASS = 'jp-CollaborationBar-controls';
const COLLABORATION_ACTIVITY_CLASS = 'jp-CollaborationBar-activity';
const COLLABORATION_DROPDOWN_CLASS = 'jp-CollaborationBar-dropdown';
const COLLABORATION_AVATAR_CLASS = 'jp-CollaborationBar-avatar';
const COLLABORATION_BUTTON_CLASS = 'jp-CollaborationBar-button';
const COLLABORATION_BADGE_CLASS = 'jp-CollaborationBar-badge';
const COLLABORATION_TOOLTIP_CLASS = 'jp-CollaborationBar-tooltip';

/**
 * User presence information structure
 */
interface IUserPresence {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  color: string;
  isActive: boolean;
  lastSeen: Date;
  currentCell?: string;
  role: 'viewer' | 'editor' | 'admin';
}

/**
 * Activity feed event structure
 */
interface IActivityEvent {
  id: string;
  type: 'edit' | 'comment' | 'join' | 'leave' | 'lock' | 'unlock' | 'history';
  userId: string;
  userName: string;
  timestamp: Date;
  cellId?: string;
  description: string;
  metadata?: Record<string, any>;
}

/**
 * Collaboration session status
 */
interface ICollaborationStatus {
  isEnabled: boolean;
  isConnected: boolean;
  isOnline: boolean;
  sessionId?: string;
  connectedUsers: number;
  lastSync?: Date;
  hasErrors: boolean;
  errorMessage?: string;
}

/**
 * Mock collaboration service interfaces (would be injected in real implementation)
 */
interface IAwarenessService {
  getConnectedUsers(): IUserPresence[];
  getCurrentUser(): IUserPresence | null;
  onUsersChanged: (callback: (users: IUserPresence[]) => void) => void;
  removeUsersChangedListener: (callback: (users: IUserPresence[]) => void) => void;
}

interface IActivityService {
  getRecentEvents(limit?: number): IActivityEvent[];
  onNewEvent: (callback: (event: IActivityEvent) => void) => void;
  removeEventListener: (callback: (event: IActivityEvent) => void) => void;
}

interface ICollaborationService {
  getStatus(): ICollaborationStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onStatusChanged: (callback: (status: ICollaborationStatus) => void) => void;
  removeStatusListener: (callback: (status: ICollaborationStatus) => void) => void;
}

interface ILockService {
  isLocked(cellId: string): boolean;
  getLockOwner(cellId: string): string | null;
  requestLock(cellId: string): Promise<boolean>;
  releaseLock(cellId: string): Promise<boolean>;
}

interface ICommentService {
  hasComments(cellId: string): boolean;
  getCommentCount(cellId?: string): number;
  openCommentPanel(): void;
  createComment(cellId: string): void;
}

interface IHistoryService {
  openHistoryViewer(): void;
  hasHistory(): boolean;
  getLastModified(): Date | null;
}

interface IPermissionService {
  getCurrentRole(): 'viewer' | 'editor' | 'admin';
  canEdit(): boolean;
  canComment(): boolean;
  canManagePermissions(): boolean;
  openPermissionsDialog(): void;
}

/**
 * Props for the CollaborationBar component
 */
interface ICollaborationBarProps {
  app: JupyterFrontEnd;
  translator: ITranslator;
  tracker: INotebookTracker;
  awarenessService?: IAwarenessService;
  activityService?: IActivityService;
  collaborationService?: ICollaborationService;
  lockService?: ILockService;
  commentService?: ICommentService;
  historyService?: IHistoryService;
  permissionService?: IPermissionService;
}

/**
 * Avatar component for displaying user presence
 */
const UserAvatar: React.FC<{
  user: IUserPresence;
  size?: 'small' | 'medium' | 'large';
  showTooltip?: boolean;
  onClick?: () => void;
}> = ({ user, size = 'medium', showTooltip = true, onClick }) => {
  const [showTooltipContent, setShowTooltipContent] = useState(false);

  const sizeClass = {
    small: 'jp-CollaborationBar-avatar-small',
    medium: 'jp-CollaborationBar-avatar-medium',
    large: 'jp-CollaborationBar-avatar-large'
  }[size];

  const avatarStyle = {
    backgroundColor: user.color,
    borderColor: user.isActive ? user.color : '#ccc',
    opacity: user.isActive ? 1 : 0.6
  };

  const initials = user.name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const tooltipContent = showTooltip && showTooltipContent && (
    <div className={COLLABORATION_TOOLTIP_CLASS} role="tooltip">
      <div className="jp-CollaborationBar-tooltip-content">
        <strong>{user.name}</strong>
        <div className="jp-CollaborationBar-tooltip-role">
          {user.role === 'admin' ? '👑 Admin' : user.role === 'editor' ? '✏️ Editor' : '👁️ Viewer'}
        </div>
        <div className="jp-CollaborationBar-tooltip-status">
          {user.isActive ? '🟢 Active' : `⭕ Last seen ${formatRelativeTime(user.lastSeen)}`}
        </div>
        {user.currentCell && (
          <div className="jp-CollaborationBar-tooltip-location">
            📍 In cell {user.currentCell}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={`${COLLABORATION_AVATAR_CLASS} ${sizeClass}`}
      style={avatarStyle}
      onClick={onClick}
      onMouseEnter={() => setShowTooltipContent(true)}
      onMouseLeave={() => setShowTooltipContent(false)}
      role="button"
      tabIndex={0}
      aria-label={`${user.name} (${user.role})`}
      aria-describedby={showTooltipContent ? `tooltip-${user.id}` : undefined}
    >
      {user.avatar ? (
        <img 
          src={user.avatar} 
          alt={user.name}
          className="jp-CollaborationBar-avatar-image"
        />
      ) : (
        <span className="jp-CollaborationBar-avatar-initials">
          {initials}
        </span>
      )}
      {user.isActive && (
        <div className="jp-CollaborationBar-avatar-indicator" aria-hidden="true" />
      )}
      {tooltipContent}
    </div>
  );
};

/**
 * Activity feed dropdown component
 */
const ActivityFeed: React.FC<{
  events: IActivityEvent[];
  isOpen: boolean;
  onClose: () => void;
  translator: ITranslator;
}> = ({ events, isOpen, onClose, translator }) => {
  const trans = translator.load('jupyterlab');

  if (!isOpen) return null;

  const renderEventIcon = (type: string) => {
    switch (type) {
      case 'edit': return '✏️';
      case 'comment': return '💬';
      case 'join': return '👋';
      case 'leave': return '👋';
      case 'lock': return '🔒';
      case 'unlock': return '🔓';
      case 'history': return '📜';
      default: return '📝';
    }
  };

  return (
    <div className={COLLABORATION_DROPDOWN_CLASS} role="dialog" aria-label={trans.__('Activity Feed')}>
      <div className="jp-CollaborationBar-dropdown-header">
        <h3>{trans.__('Recent Activity')}</h3>
        <button 
          className="jp-CollaborationBar-dropdown-close"
          onClick={onClose}
          aria-label={trans.__('Close activity feed')}
        >
          ✕
        </button>
      </div>
      <div className="jp-CollaborationBar-dropdown-content">
        {events.length === 0 ? (
          <div className="jp-CollaborationBar-empty-state">
            <p>{trans.__('No recent activity')}</p>
          </div>
        ) : (
          <ul className="jp-CollaborationBar-activity-list" role="list">
            {events.map(event => (
              <li key={event.id} className="jp-CollaborationBar-activity-item" role="listitem">
                <div className="jp-CollaborationBar-activity-icon" aria-hidden="true">
                  {renderEventIcon(event.type)}
                </div>
                <div className="jp-CollaborationBar-activity-content">
                  <div className="jp-CollaborationBar-activity-description">
                    <strong>{event.userName}</strong> {event.description}
                  </div>
                  <div className="jp-CollaborationBar-activity-timestamp">
                    {formatRelativeTime(event.timestamp)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/**
 * Utility function to format relative time
 */
const formatRelativeTime = (date: Date): string => {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return 'just now';
  } else if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60);
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  } else if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600);
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  } else {
    const days = Math.floor(diffInSeconds / 86400);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
  }
};

/**
 * Main CollaborationBar React component
 */
const CollaborationBar: React.FC<ICollaborationBarProps> = ({
  app,
  translator,
  tracker,
  awarenessService,
  activityService,
  collaborationService,
  lockService,
  commentService,
  historyService,
  permissionService
}) => {
  const trans = translator.load('jupyterlab');

  // State management
  const [status, setStatus] = useState<ICollaborationStatus>({
    isEnabled: false,
    isConnected: false,
    isOnline: false,
    connectedUsers: 0,
    hasErrors: false
  });

  const [users, setUsers] = useState<IUserPresence[]>([]);
  const [recentEvents, setRecentEvents] = useState<IActivityEvent[]>([]);
  const [showActivityFeed, setShowActivityFeed] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Update collaboration status
  const updateStatus = useCallback(() => {
    if (collaborationService) {
      const newStatus = collaborationService.getStatus();
      setStatus(newStatus);
    }
  }, [collaborationService]);

  // Update connected users
  const updateUsers = useCallback(() => {
    if (awarenessService) {
      const connectedUsers = awarenessService.getConnectedUsers();
      setUsers(connectedUsers);
    }
  }, [awarenessService]);

  // Update recent events
  const updateEvents = useCallback(() => {
    if (activityService) {
      const events = activityService.getRecentEvents(10);
      setRecentEvents(events);
    }
  }, [activityService]);

  // Handle new activity event
  const handleNewEvent = useCallback((event: IActivityEvent) => {
    setRecentEvents(prev => [event, ...prev.slice(0, 9)]);
  }, []);

  // Set up service listeners
  useEffect(() => {
    if (collaborationService) {
      updateStatus();
      collaborationService.onStatusChanged(setStatus);
      
      return () => {
        collaborationService.removeStatusListener(setStatus);
      };
    }
  }, [collaborationService, updateStatus]);

  useEffect(() => {
    if (awarenessService) {
      updateUsers();
      awarenessService.onUsersChanged(setUsers);
      
      return () => {
        awarenessService.removeUsersChangedListener(setUsers);
      };
    }
  }, [awarenessService, updateUsers]);

  useEffect(() => {
    if (activityService) {
      updateEvents();
      activityService.onNewEvent(handleNewEvent);
      
      return () => {
        activityService.removeEventListener(handleNewEvent);
      };
    }
  }, [activityService, updateEvents, handleNewEvent]);

  // Handle responsive design
  useEffect(() => {
    const handleResize = () => {
      const isSmallScreen = window.innerWidth < 768;
      setIsCollapsed(isSmallScreen);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Action handlers
  const handleConnect = useCallback(async () => {
    if (collaborationService && !status.isConnected) {
      try {
        await collaborationService.connect();
      } catch (error) {
        console.error('Failed to connect to collaboration service:', error);
      }
    }
  }, [collaborationService, status.isConnected]);

  const handleDisconnect = useCallback(async () => {
    if (collaborationService && status.isConnected) {
      try {
        await collaborationService.disconnect();
      } catch (error) {
        console.error('Failed to disconnect from collaboration service:', error);
      }
    }
  }, [collaborationService, status.isConnected]);

  const handleOpenComments = useCallback(() => {
    if (commentService) {
      commentService.openCommentPanel();
    }
  }, [commentService]);

  const handleOpenHistory = useCallback(() => {
    if (historyService) {
      historyService.openHistoryViewer();
    }
  }, [historyService]);

  const handleOpenPermissions = useCallback(() => {
    if (permissionService) {
      permissionService.openPermissionsDialog();
    }
  }, [permissionService]);

  const handleToggleActivityFeed = useCallback(() => {
    setShowActivityFeed(prev => !prev);
  }, []);

  // Computed values
  const currentUser = useMemo(() => {
    return awarenessService?.getCurrentUser() || null;
  }, [awarenessService]);

  const canEdit = useMemo(() => {
    return permissionService?.canEdit() ?? true;
  }, [permissionService]);

  const canComment = useMemo(() => {
    return permissionService?.canComment() ?? true;
  }, [permissionService]);

  const canManagePermissions = useMemo(() => {
    return permissionService?.canManagePermissions() ?? false;
  }, [permissionService]);

  const hasComments = useMemo(() => {
    return commentService?.getCommentCount() ?? 0;
  }, [commentService]);

  const hasHistory = useMemo(() => {
    return historyService?.hasHistory() ?? false;
  }, [historyService]);

  // Status indicator
  const StatusIndicator: React.FC = () => {
    const getStatusColor = () => {
      if (!status.isEnabled) return '#6c757d';
      if (status.hasErrors) return '#dc3545';
      if (!status.isConnected) return '#fd7e14';
      return '#28a745';
    };

    const getStatusText = () => {
      if (!status.isEnabled) return trans.__('Collaboration Disabled');
      if (status.hasErrors) return trans.__('Connection Error');
      if (!status.isConnected) return trans.__('Connecting...');
      return trans.__('Connected');
    };

    return (
      <div className={COLLABORATION_STATUS_CLASS}>
        <div 
          className="jp-CollaborationBar-status-indicator"
          style={{ backgroundColor: getStatusColor() }}
          aria-hidden="true"
        />
        <span className="jp-CollaborationBar-status-text" aria-live="polite">
          {getStatusText()}
          {status.isConnected && (
            <span className="jp-CollaborationBar-user-count">
              ({status.connectedUsers} {status.connectedUsers === 1 ? 'user' : 'users'})
            </span>
          )}
        </span>
      </div>
    );
  };

  // Render collapsed mobile view
  if (isCollapsed) {
    return (
      <div className={`${COLLABORATION_BAR_CLASS} ${COLLABORATION_BAR_CLASS}-collapsed`}>
        <div className={COLLABORATION_BAR_CONTAINER_CLASS}>
          <button
            className={`${COLLABORATION_BUTTON_CLASS} jp-CollaborationBar-mobile-button`}
            onClick={handleToggleActivityFeed}
            aria-label={trans.__('Open collaboration menu')}
          >
            👥 {status.connectedUsers}
          </button>
          {showActivityFeed && (
            <ActivityFeed
              events={recentEvents}
              isOpen={showActivityFeed}
              onClose={() => setShowActivityFeed(false)}
              translator={translator}
            />
          )}
        </div>
      </div>
    );
  }

  // Main desktop/tablet view
  return (
    <div className={COLLABORATION_BAR_CLASS} role="toolbar" aria-label={trans.__('Collaboration Toolbar')}>
      <div className={COLLABORATION_BAR_CONTAINER_CLASS}>
        {/* Status Section */}
        <StatusIndicator />

        {/* User Avatars Section */}
        <div className={COLLABORATION_AVATARS_CLASS} role="group" aria-label={trans.__('Connected Users')}>
          {users.slice(0, 5).map(user => (
            <UserAvatar
              key={user.id}
              user={user}
              size="medium"
              showTooltip={true}
            />
          ))}
          {users.length > 5 && (
            <div className={`${COLLABORATION_AVATAR_CLASS} jp-CollaborationBar-avatar-overflow`}>
              +{users.length - 5}
            </div>
          )}
        </div>

        {/* Controls Section */}
        <div className={COLLABORATION_CONTROLS_CLASS} role="group" aria-label={trans.__('Collaboration Controls')}>
          {/* Connection Toggle */}
          {status.isEnabled && (
            <button
              className={`${COLLABORATION_BUTTON_CLASS} ${status.isConnected ? 'jp-mod-active' : ''}`}
              onClick={status.isConnected ? handleDisconnect : handleConnect}
              disabled={!status.isEnabled}
              aria-label={status.isConnected ? trans.__('Disconnect from collaboration') : trans.__('Connect to collaboration')}
              title={status.isConnected ? trans.__('Disconnect') : trans.__('Connect')}
            >
              {status.isConnected ? '🔗' : '⛓️‍💥'}
            </button>
          )}

          {/* Comments Button */}
          <button
            className={`${COLLABORATION_BUTTON_CLASS} ${hasComments > 0 ? 'jp-mod-active' : ''}`}
            onClick={handleOpenComments}
            disabled={!canComment}
            aria-label={trans.__('Open comments panel')}
            title={trans.__('Comments')}
          >
            💬
            {hasComments > 0 && (
              <span className={COLLABORATION_BADGE_CLASS} aria-label={`${hasComments} comments`}>
                {hasComments}
              </span>
            )}
          </button>

          {/* History Button */}
          <button
            className={`${COLLABORATION_BUTTON_CLASS} ${hasHistory ? 'jp-mod-active' : ''}`}
            onClick={handleOpenHistory}
            disabled={!hasHistory}
            aria-label={trans.__('Open version history')}
            title={trans.__('History')}
          >
            📜
          </button>

          {/* Permissions Button */}
          {canManagePermissions && (
            <button
              className={COLLABORATION_BUTTON_CLASS}
              onClick={handleOpenPermissions}
              aria-label={trans.__('Manage permissions')}
              title={trans.__('Permissions')}
            >
              👑
            </button>
          )}

          {/* Activity Feed Toggle */}
          <button
            className={`${COLLABORATION_BUTTON_CLASS} ${showActivityFeed ? 'jp-mod-active' : ''}`}
            onClick={handleToggleActivityFeed}
            aria-label={trans.__('Toggle activity feed')}
            title={trans.__('Activity')}
            aria-expanded={showActivityFeed}
          >
            📊
            {recentEvents.length > 0 && (
              <span className={COLLABORATION_BADGE_CLASS} aria-label={`${recentEvents.length} recent events`}>
                {recentEvents.length}
              </span>
            )}
          </button>
        </div>

        {/* Activity Feed Dropdown */}
        <div className={COLLABORATION_ACTIVITY_CLASS}>
          <ActivityFeed
            events={recentEvents}
            isOpen={showActivityFeed}
            onClose={() => setShowActivityFeed(false)}
            translator={translator}
          />
        </div>
      </div>
    </div>
  );
};

/**
 * Namespace for CollaborationBarComponent static methods
 */
export namespace CollaborationBarComponent {
  /**
   * Create a new CollaborationBarComponent widget
   * 
   * @param options - Configuration options for the collaboration bar
   * @returns ReactWidget containing the CollaborationBar component
   */
  export const create = (options: {
    app: JupyterFrontEnd;
    translator: ITranslator;
    tracker: INotebookTracker;
    awarenessService?: IAwarenessService;
    activityService?: IActivityService;
    collaborationService?: ICollaborationService;
    lockService?: ILockService;
    commentService?: ICommentService;
    historyService?: IHistoryService;
    permissionService?: IPermissionService;
  }): ReactWidget => {
    const widget = ReactWidget.create(
      <CollaborationBar
        app={options.app}
        translator={options.translator}
        tracker={options.tracker}
        awarenessService={options.awarenessService}
        activityService={options.activityService}
        collaborationService={options.collaborationService}
        lockService={options.lockService}
        commentService={options.commentService}
        historyService={options.historyService}
        permissionService={options.permissionService}
      />
    );

    widget.addClass(COLLABORATION_BAR_CLASS);
    widget.addClass('jp-ReactWidget');

    // Set widget metadata
    widget.id = 'collaboration-bar';
    widget.title.label = 'Collaboration';
    widget.title.caption = 'Real-time collaboration toolbar';

    return widget;
  };
}

// Export the component and related interfaces
export { CollaborationBar, ICollaborationBarProps, IUserPresence, IActivityEvent, ICollaborationStatus };
export default CollaborationBarComponent;