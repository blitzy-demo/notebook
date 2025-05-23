import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { ICollaborationService, IAwarenessService, ILockService, ICommentService, IHistoryService, IPermissionsService } from '@jupyter-notebook/application';

/**
 * Activity type enum for collaboration events
 */
enum ActivityType {
  Edit = 'edit',
  Comment = 'comment',
  Lock = 'lock',
  Unlock = 'unlock',
  Join = 'join',
  Leave = 'leave',
  Permission = 'permission',
  Version = 'version'
}

/**
 * Interface for collaboration activity items
 */
interface IActivityItem {
  id: string;
  type: ActivityType;
  timestamp: number;
  userId: string;
  userName: string;
  userColor?: string;
  userAvatar?: string;
  message: string;
  cellId?: string;
  metadata?: Record<string, any>;
}

/**
 * Props for the CollaborationBar component
 */
interface ICollaborationBarProps {
  /**
   * The collaboration service
   */
  collaborationService: ICollaborationService;

  /**
   * The awareness service for user presence
   */
  awarenessService: IAwarenessService;

  /**
   * The lock service for cell locking
   */
  lockService: ILockService;

  /**
   * The comment service for document comments
   */
  commentService: ICommentService;

  /**
   * The history service for version tracking
   */
  historyService: IHistoryService;

  /**
   * The permissions service for access control
   */
  permissionsService: IPermissionsService;

  /**
   * The document path
   */
  documentPath: string;

  /**
   * The translator
   */
  translator?: ITranslator;
}

/**
 * CollaborationBar component displays real-time collaboration status and activity
 */
const CollaborationBar: React.FC<ICollaborationBarProps> = ({
  collaborationService,
  awarenessService,
  lockService,
  commentService,
  historyService,
  permissionsService,
  documentPath,
  translator = nullTranslator
}) => {
  const trans = translator.load('notebook');
  
  // State for connected users
  const [connectedUsers, setConnectedUsers] = useState<Map<number, IAwarenessService.IState>>(new Map());
  
  // State for activity feed
  const [activities, setActivities] = useState<IActivityItem[]>([]);
  
  // State for collaboration status
  const [status, setStatus] = useState<ICollaborationService.Status>(ICollaborationService.Status.Disabled);
  
  // State for notifications
  const [notifications, setNotifications] = useState<IActivityItem[]>([]);
  
  // State for expanded sections
  const [expandedSections, setExpandedSections] = useState({
    users: true,
    activity: true,
    notifications: false
  });

  /**
   * Toggle a section's expanded state
   */
  const toggleSection = useCallback((section: 'users' | 'activity' | 'notifications') => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  }, []);

  /**
   * Add a new activity to the feed
   */
  const addActivity = useCallback((activity: IActivityItem) => {
    setActivities(prev => [activity, ...prev].slice(0, 50)); // Keep last 50 activities
    
    // Add to notifications if it's a relevant event
    if (
      activity.type === ActivityType.Comment ||
      activity.type === ActivityType.Lock ||
      activity.type === ActivityType.Permission
    ) {
      setNotifications(prev => [activity, ...prev].slice(0, 10)); // Keep last 10 notifications
    }
  }, []);

  /**
   * Clear a notification
   */
  const clearNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(notification => notification.id !== id));
  }, []);

  /**
   * Clear all notifications
   */
  const clearAllNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  /**
   * Format timestamp to readable time
   */
  const formatTime = useCallback((timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    
    if (diff < 60000) { // Less than 1 minute
      return trans.__('just now');
    } else if (diff < 3600000) { // Less than 1 hour
      const minutes = Math.floor(diff / 60000);
      return trans.__('%1 min ago', minutes);
    } else if (diff < 86400000) { // Less than 1 day
      const hours = Math.floor(diff / 3600000);
      return trans.__('%1 hr ago', hours);
    } else {
      const date = new Date(timestamp);
      return date.toLocaleString();
    }
  }, [trans]);

  /**
   * Get activity icon based on type
   */
  const getActivityIcon = useCallback((type: ActivityType): string => {
    switch (type) {
      case ActivityType.Edit:
        return '✏️';
      case ActivityType.Comment:
        return '💬';
      case ActivityType.Lock:
        return '🔒';
      case ActivityType.Unlock:
        return '🔓';
      case ActivityType.Join:
        return '👋';
      case ActivityType.Leave:
        return '👋';
      case ActivityType.Permission:
        return '🔑';
      case ActivityType.Version:
        return '📝';
      default:
        return '•';
    }
  }, []);

  /**
   * Handle awareness state changes
   */
  useEffect(() => {
    const onAwarenessChange = (sender: IAwarenessService, event: IAwarenessService.IChangeEvent) => {
      // Update connected users
      setConnectedUsers(awarenessService.getStates());
      
      // Add join/leave activities
      for (const clientId of event.added) {
        const state = awarenessService.getState(clientId);
        if (state && state.user) {
          addActivity({
            id: `join-${clientId}-${Date.now()}`,
            type: ActivityType.Join,
            timestamp: Date.now(),
            userId: clientId.toString(),
            userName: state.user.name || trans.__('Anonymous'),
            userColor: state.user.color,
            userAvatar: state.user.avatar,
            message: trans.__('%1 joined the document', state.user.name || trans.__('Anonymous'))
          });
        }
      }
      
      for (const clientId of event.removed) {
        addActivity({
          id: `leave-${clientId}-${Date.now()}`,
          type: ActivityType.Leave,
          timestamp: Date.now(),
          userId: clientId.toString(),
          userName: trans.__('User'),
          message: trans.__('A user left the document')
        });
      }
    };
    
    awarenessService.stateChanged.connect(onAwarenessChange);
    
    // Initial state
    setConnectedUsers(awarenessService.getStates());
    
    return () => {
      awarenessService.stateChanged.disconnect(onAwarenessChange);
    };
  }, [awarenessService, addActivity, trans]);

  /**
   * Handle lock state changes
   */
  useEffect(() => {
    const onLockChange = (sender: ILockService, event: ILockService.IChangeEvent) => {
      const userName = getUserName(event.clientId);
      
      if (event.type === 'acquired') {
        addActivity({
          id: `lock-${event.cellId}-${Date.now()}`,
          type: ActivityType.Lock,
          timestamp: Date.now(),
          userId: event.clientId.toString(),
          userName,
          cellId: event.cellId,
          message: trans.__('%1 locked a cell', userName)
        });
      } else if (event.type === 'released') {
        addActivity({
          id: `unlock-${event.cellId}-${Date.now()}`,
          type: ActivityType.Unlock,
          timestamp: Date.now(),
          userId: event.clientId.toString(),
          userName,
          cellId: event.cellId,
          message: trans.__('%1 unlocked a cell', userName)
        });
      } else if (event.type === 'stolen') {
        const prevUserName = getUserName(event.previousOwner || 0);
        addActivity({
          id: `lock-stolen-${event.cellId}-${Date.now()}`,
          type: ActivityType.Lock,
          timestamp: Date.now(),
          userId: event.clientId.toString(),
          userName,
          cellId: event.cellId,
          message: trans.__('%1 took over a cell from %2', userName, prevUserName)
        });
      }
    };
    
    lockService.stateChanged.connect(onLockChange);
    
    return () => {
      lockService.stateChanged.disconnect(onLockChange);
    };
  }, [lockService, addActivity, trans]);

  /**
   * Handle comment changes
   */
  useEffect(() => {
    const onCommentChange = (sender: ICommentService, event: ICommentService.IChangeEvent) => {
      if (event.documentPath !== documentPath) {
        return;
      }
      
      let message = '';
      let userName = '';
      
      if (event.comment) {
        userName = event.comment.userName;
      } else if (event.reply) {
        userName = event.reply.userName;
      }
      
      switch (event.type) {
        case 'added':
          message = trans.__('%1 added a comment', userName);
          break;
        case 'updated':
          message = trans.__('%1 updated a comment', userName);
          break;
        case 'deleted':
          message = trans.__('%1 deleted a comment', userName);
          break;
        case 'resolved':
          message = trans.__('%1 resolved a comment', userName);
          break;
        case 'reply-added':
          message = trans.__('%1 replied to a comment', userName);
          break;
        case 'reply-updated':
          message = trans.__('%1 updated a reply', userName);
          break;
        case 'reply-deleted':
          message = trans.__('%1 deleted a reply', userName);
          break;
      }
      
      addActivity({
        id: `comment-${event.commentId}-${event.type}-${Date.now()}`,
        type: ActivityType.Comment,
        timestamp: Date.now(),
        userId: event.comment?.userId || event.reply?.userId || '',
        userName,
        message,
        metadata: {
          commentId: event.commentId,
          replyId: event.replyId
        }
      });
    };
    
    commentService.commentsChanged.connect(onCommentChange);
    
    return () => {
      commentService.commentsChanged.disconnect(onCommentChange);
    };
  }, [commentService, documentPath, addActivity, trans]);

  /**
   * Handle history changes
   */
  useEffect(() => {
    const onHistoryChange = () => {
      // We'll just add a generic activity for now
      // In a real implementation, we would get more details about the version
      addActivity({
        id: `version-${Date.now()}`,
        type: ActivityType.Version,
        timestamp: Date.now(),
        userId: awarenessService.clientID.toString(),
        userName: getUserName(awarenessService.clientID),
        message: trans.__('Document version updated')
      });
    };
    
    historyService.stateChanged.connect(onHistoryChange);
    
    return () => {
      historyService.stateChanged.disconnect(onHistoryChange);
    };
  }, [historyService, awarenessService, addActivity, trans]);

  /**
   * Handle permission changes
   */
  useEffect(() => {
    const onPermissionChange = (sender: IPermissionsService, event: IPermissionsService.IChangeEvent) => {
      if (event.documentPath !== documentPath) {
        return;
      }
      
      addActivity({
        id: `permission-${Date.now()}`,
        type: ActivityType.Permission,
        timestamp: Date.now(),
        userId: awarenessService.clientID.toString(),
        userName: getUserName(awarenessService.clientID),
        message: event.userId 
          ? trans.__('Permissions changed for a user') 
          : trans.__('Document permissions updated')
      });
    };
    
    permissionsService.permissionsChanged.connect(onPermissionChange);
    
    return () => {
      permissionsService.permissionsChanged.disconnect(onPermissionChange);
    };
  }, [permissionsService, documentPath, awarenessService, addActivity, trans]);

  /**
   * Handle collaboration service status changes
   */
  useEffect(() => {
    const onStatusChange = () => {
      setStatus(collaborationService.getStatus());
    };
    
    collaborationService.stateChanged.connect(onStatusChange);
    
    // Initial status
    setStatus(collaborationService.getStatus());
    
    return () => {
      collaborationService.stateChanged.disconnect(onStatusChange);
    };
  }, [collaborationService]);

  /**
   * Helper to get user name from client ID
   */
  const getUserName = useCallback((clientId: number): string => {
    const state = awarenessService.getState(clientId);
    return state?.user?.name || trans.__('Anonymous');
  }, [awarenessService, trans]);

  /**
   * Render user avatar
   */
  const renderAvatar = useCallback((state: IAwarenessService.IState, clientId: number) => {
    const user = state.user || {};
    const name = user.name || trans.__('Anonymous');
    const color = user.color || '#6E7B8B';
    const initials = name.split(' ')
      .map(part => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
    
    return (
      <div 
        key={clientId}
        className="jp-CollaborationBar-avatar"
        style={{ backgroundColor: color }}
        title={name}
      >
        {user.avatar ? (
          <img src={user.avatar} alt={name} />
        ) : (
          <span>{initials}</span>
        )}
        <div className="jp-CollaborationBar-status" />
      </div>
    );
  }, [trans]);

  /**
   * Render status indicator
   */
  const renderStatus = useMemo(() => {
    let statusText = '';
    let statusClass = '';
    
    switch (status) {
      case ICollaborationService.Status.Connected:
        statusText = trans.__('Connected');
        statusClass = 'jp-CollaborationBar-statusConnected';
        break;
      case ICollaborationService.Status.Connecting:
        statusText = trans.__('Connecting...');
        statusClass = 'jp-CollaborationBar-statusConnecting';
        break;
      case ICollaborationService.Status.Disconnected:
        statusText = trans.__('Disconnected');
        statusClass = 'jp-CollaborationBar-statusDisconnected';
        break;
      case ICollaborationService.Status.Error:
        statusText = trans.__('Connection Error');
        statusClass = 'jp-CollaborationBar-statusError';
        break;
      default:
        statusText = trans.__('Collaboration Disabled');
        statusClass = 'jp-CollaborationBar-statusDisabled';
    }
    
    return (
      <div className={`jp-CollaborationBar-statusIndicator ${statusClass}`}>
        <span className="jp-CollaborationBar-statusDot" />
        <span className="jp-CollaborationBar-statusText">{statusText}</span>
      </div>
    );
  }, [status, trans]);

  /**
   * Handle reconnect button click
   */
  const handleReconnect = useCallback(async () => {
    if (status === ICollaborationService.Status.Disconnected || 
        status === ICollaborationService.Status.Error) {
      try {
        await collaborationService.reconnect();
      } catch (error) {
        console.error('Failed to reconnect:', error);
      }
    }
  }, [collaborationService, status]);

  /**
   * Render quick action buttons
   */
  const renderQuickActions = useMemo(() => {
    return (
      <div className="jp-CollaborationBar-actions">
        <button 
          className="jp-CollaborationBar-actionButton jp-CollaborationBar-historyButton"
          title={trans.__('View History')}
          onClick={() => {
            // This would typically open the history viewer
            console.log('Open history viewer');
          }}
        >
          <span className="jp-CollaborationBar-actionIcon">📝</span>
        </button>
        <button 
          className="jp-CollaborationBar-actionButton jp-CollaborationBar-commentsButton"
          title={trans.__('View Comments')}
          onClick={() => {
            // This would typically open the comments panel
            console.log('Open comments panel');
          }}
        >
          <span className="jp-CollaborationBar-actionIcon">💬</span>
        </button>
        <button 
          className="jp-CollaborationBar-actionButton jp-CollaborationBar-permissionsButton"
          title={trans.__('Manage Permissions')}
          onClick={() => {
            // This would typically open the permissions dialog
            console.log('Open permissions dialog');
          }}
        >
          <span className="jp-CollaborationBar-actionIcon">🔑</span>
        </button>
      </div>
    );
  }, [trans]);

  // If collaboration is disabled, show minimal UI
  if (status === ICollaborationService.Status.Disabled) {
    return (
      <div className="jp-CollaborationBar jp-CollaborationBar-disabled">
        <div className="jp-CollaborationBar-header">
          {renderStatus}
        </div>
      </div>
    );
  }

  return (
    <div className="jp-CollaborationBar">
      <div className="jp-CollaborationBar-header">
        {renderStatus}
        {(status === ICollaborationService.Status.Disconnected || 
          status === ICollaborationService.Status.Error) && (
          <button 
            className="jp-CollaborationBar-reconnectButton"
            onClick={handleReconnect}
          >
            {trans.__('Reconnect')}
          </button>
        )}
        {renderQuickActions}
      </div>
      
      {/* Users Section */}
      <div className="jp-CollaborationBar-section">
        <div 
          className="jp-CollaborationBar-sectionHeader"
          onClick={() => toggleSection('users')}
        >
          <span className="jp-CollaborationBar-sectionTitle">
            {trans.__('Users (%1)', connectedUsers.size)}
          </span>
          <span className="jp-CollaborationBar-sectionToggle">
            {expandedSections.users ? '▼' : '►'}
          </span>
        </div>
        {expandedSections.users && (
          <div className="jp-CollaborationBar-sectionContent jp-CollaborationBar-userList">
            {connectedUsers.size > 0 ? (
              Array.from(connectedUsers.entries()).map(([clientId, state]) => (
                renderAvatar(state, clientId)
              ))
            ) : (
              <div className="jp-CollaborationBar-emptyState">
                {trans.__('No other users connected')}
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Activity Feed Section */}
      <div className="jp-CollaborationBar-section">
        <div 
          className="jp-CollaborationBar-sectionHeader"
          onClick={() => toggleSection('activity')}
        >
          <span className="jp-CollaborationBar-sectionTitle">
            {trans.__('Recent Activity')}
          </span>
          <span className="jp-CollaborationBar-sectionToggle">
            {expandedSections.activity ? '▼' : '►'}
          </span>
        </div>
        {expandedSections.activity && (
          <div className="jp-CollaborationBar-sectionContent jp-CollaborationBar-activityFeed">
            {activities.length > 0 ? (
              activities.map(activity => (
                <div key={activity.id} className="jp-CollaborationBar-activityItem">
                  <div className="jp-CollaborationBar-activityIcon">
                    {getActivityIcon(activity.type)}
                  </div>
                  <div className="jp-CollaborationBar-activityContent">
                    <div className="jp-CollaborationBar-activityMessage">
                      {activity.message}
                    </div>
                    <div className="jp-CollaborationBar-activityTime">
                      {formatTime(activity.timestamp)}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="jp-CollaborationBar-emptyState">
                {trans.__('No recent activity')}
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Notifications Section */}
      <div className="jp-CollaborationBar-section">
        <div 
          className="jp-CollaborationBar-sectionHeader"
          onClick={() => toggleSection('notifications')}
        >
          <span className="jp-CollaborationBar-sectionTitle">
            {trans.__('Notifications (%1)', notifications.length)}
          </span>
          <span className="jp-CollaborationBar-sectionToggle">
            {expandedSections.notifications ? '▼' : '►'}
          </span>
          {notifications.length > 0 && (
            <button 
              className="jp-CollaborationBar-clearAllButton"
              onClick={(e) => {
                e.stopPropagation();
                clearAllNotifications();
              }}
            >
              {trans.__('Clear All')}
            </button>
          )}
        </div>
        {expandedSections.notifications && (
          <div className="jp-CollaborationBar-sectionContent jp-CollaborationBar-notificationList">
            {notifications.length > 0 ? (
              notifications.map(notification => (
                <div key={notification.id} className="jp-CollaborationBar-notificationItem">
                  <div className="jp-CollaborationBar-notificationIcon">
                    {getActivityIcon(notification.type)}
                  </div>
                  <div className="jp-CollaborationBar-notificationContent">
                    <div className="jp-CollaborationBar-notificationMessage">
                      {notification.message}
                    </div>
                    <div className="jp-CollaborationBar-notificationTime">
                      {formatTime(notification.timestamp)}
                    </div>
                  </div>
                  <button 
                    className="jp-CollaborationBar-notificationDismiss"
                    onClick={() => clearNotification(notification.id)}
                    title={trans.__('Dismiss')}
                  >
                    ×
                  </button>
                </div>
              ))
            ) : (
              <div className="jp-CollaborationBar-emptyState">
                {trans.__('No notifications')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * A namespace for CollaborationBar statics.
 */
export namespace CollaborationBarComponent {
  /**
   * Create a new CollaborationBar widget.
   */
  export function create(options: {
    collaborationService: ICollaborationService;
    awarenessService: IAwarenessService;
    lockService: ILockService;
    commentService: ICommentService;
    historyService: IHistoryService;
    permissionsService: IPermissionsService;
    documentPath: string;
    translator?: ITranslator;
  }): ReactWidget {
    return ReactWidget.create(
      <CollaborationBar
        collaborationService={options.collaborationService}
        awarenessService={options.awarenessService}
        lockService={options.lockService}
        commentService={options.commentService}
        historyService={options.historyService}
        permissionsService={options.permissionsService}
        documentPath={options.documentPath}
        translator={options.translator}
      />
    );
  }
}

export default CollaborationBarComponent;