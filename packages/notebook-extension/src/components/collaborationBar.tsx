/**
 * Collaboration Bar component for Jupyter Notebook v7
 * 
 * This component provides a central interface for collaboration status and activity in Jupyter notebooks.
 * It displays a persistent bar showing connected users, recent activities, and collaboration status.
 * It integrates with multiple collaboration services to aggregate and display real-time collaboration information.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Time } from '@jupyterlab/coreutils';
import { ISignal } from '@lumino/signaling';

// Import interfaces from collaboration services
import { IAwarenessState, IYjsAwareness } from '../../notebook/src/collab/awareness';
import { ILockInfo, ILockManager, LockManagerStatus } from '../../notebook/src/collab/locks';
import { 
  ICommentSystem, 
  ICommentThread, 
  IComment, 
  ICommentNotification,
  CommentChangeType,
  ICommentChangeEvent
} from '../../notebook/src/collab/comments';
import { IHistoryManager } from '../../notebook/src/collab/history';

/**
 * Interface for collaboration services
 */
export interface ICollaborationServices {
  /**
   * Awareness service for user presence information
   */
  awarenessService: IYjsAwareness;

  /**
   * Lock service for cell-level locking
   */
  lockService: ILockManager;

  /**
   * Comment service for comments and review
   */
  commentService: ICommentSystem;

  /**
   * History service for version history
   */
  historyService: IHistoryManager;
}

/**
 * Interface for collaboration activity item
 */
interface IActivityItem {
  /**
   * Type of activity
   */
  type: 'edit' | 'comment' | 'lock' | 'unlock' | 'presence' | 'history';

  /**
   * User who performed the activity
   */
  user: {
    id: string;
    name: string;
    avatar?: string;
  };

  /**
   * Timestamp of the activity
   */
  timestamp: number;

  /**
   * Description of the activity
   */
  description: string;

  /**
   * Target of the activity (e.g., cell ID, comment ID)
   */
  target?: string;

  /**
   * Additional metadata for the activity
   */
  metadata?: Record<string, any>;
}

/**
 * Props for the CollaborationBar component
 */
interface ICollaborationBarProps {
  /**
   * Collaboration services
   */
  services: ICollaborationServices;

  /**
   * Notebook tracker
   */
  notebookTracker: INotebookTracker;

  /**
   * Translator
   */
  translator?: ITranslator;
}

/**
 * State for the CollaborationBar component
 */
interface ICollaborationBarState {
  /**
   * Connected users
   */
  users: Map<number, IAwarenessState>;

  /**
   * Active locks
   */
  locks: ILockInfo[];

  /**
   * Recent activities
   */
  activities: IActivityItem[];

  /**
   * Unread notifications
   */
  notifications: ICommentNotification[];

  /**
   * Whether the activity feed is expanded
   */
  isActivityFeedExpanded: boolean;

  /**
   * Whether the user list is expanded
   */
  isUserListExpanded: boolean;

  /**
   * Status of the lock service
   */
  lockServiceStatus: LockManagerStatus;
}

/**
 * Maximum number of activities to show in the feed
 */
const MAX_ACTIVITIES = 50;

/**
 * Maximum number of users to show in the collapsed view
 */
const MAX_VISIBLE_USERS = 5;

/**
 * CollaborationBar component
 */
const CollaborationBar: React.FC<ICollaborationBarProps> = ({
  services,
  notebookTracker,
  translator = nullTranslator
}) => {
  const trans = translator.load('notebook');
  
  // Initialize state
  const [state, setState] = useState<ICollaborationBarState>({
    users: new Map<number, IAwarenessState>(),
    locks: [],
    activities: [],
    notifications: [],
    isActivityFeedExpanded: false,
    isUserListExpanded: false,
    lockServiceStatus: LockManagerStatus.Initializing
  });

  /**
   * Add an activity to the activity feed
   */
  const addActivity = useCallback((activity: IActivityItem) => {
    setState(prevState => {
      const activities = [activity, ...prevState.activities];
      // Limit the number of activities
      if (activities.length > MAX_ACTIVITIES) {
        activities.pop();
      }
      return { ...prevState, activities };
    });
  }, []);

  /**
   * Handle awareness changes
   */
  const handleAwarenessChange = useCallback((changes: { added: number[]; updated: number[]; removed: number[] }) => {
    const states = services.awarenessService.getStates();
    
    // Add activity for new users
    if (changes.added.length > 0) {
      changes.added.forEach(clientId => {
        const state = states.get(clientId);
        if (state && state.user) {
          addActivity({
            type: 'presence',
            user: {
              id: state.user.name,
              name: state.user.name,
              avatar: state.user.avatar
            },
            timestamp: Date.now(),
            description: trans.__('%1 joined the notebook', state.user.name)
          });
        }
      });
    }
    
    // Add activity for removed users
    if (changes.removed.length > 0) {
      changes.removed.forEach(clientId => {
        const state = states.get(clientId);
        if (state && state.user) {
          addActivity({
            type: 'presence',
            user: {
              id: state.user.name,
              name: state.user.name,
              avatar: state.user.avatar
            },
            timestamp: Date.now(),
            description: trans.__('%1 left the notebook', state.user.name)
          });
        }
      });
    }
    
    setState(prevState => ({
      ...prevState,
      users: new Map(states)
    }));
  }, [services.awarenessService, addActivity, trans]);

  /**
   * Handle lock changes
   */
  const handleLockAcquired = useCallback((lock: ILockInfo) => {
    addActivity({
      type: 'lock',
      user: {
        id: lock.userId,
        name: lock.userName
      },
      timestamp: lock.timestamp,
      description: trans.__('%1 locked cell %2', lock.userName, lock.cellId.slice(0, 8)),
      target: lock.cellId,
      metadata: { lock }
    });
    
    setState(prevState => ({
      ...prevState,
      locks: services.lockService.getAllLocks()
    }));
  }, [services.lockService, addActivity, trans]);

  /**
   * Handle lock releases
   */
  const handleLockReleased = useCallback((lock: ILockInfo) => {
    addActivity({
      type: 'unlock',
      user: {
        id: lock.userId,
        name: lock.userName
      },
      timestamp: Date.now(),
      description: trans.__('%1 unlocked cell %2', lock.userName, lock.cellId.slice(0, 8)),
      target: lock.cellId,
      metadata: { lock }
    });
    
    setState(prevState => ({
      ...prevState,
      locks: services.lockService.getAllLocks()
    }));
  }, [services.lockService, addActivity, trans]);

  /**
   * Handle lock service status changes
   */
  const handleLockStatusChanged = useCallback((status: LockManagerStatus) => {
    setState(prevState => ({
      ...prevState,
      lockServiceStatus: status
    }));
  }, []);

  /**
   * Handle comment changes
   */
  const handleCommentChange = useCallback((event: ICommentChangeEvent) => {
    switch (event.type) {
      case CommentChangeType.CommentAdded:
        if (event.comment && event.threadId) {
          addActivity({
            type: 'comment',
            user: {
              id: event.comment.author.id,
              name: event.comment.author.displayName,
              avatar: event.comment.author.avatarUrl
            },
            timestamp: event.comment.createdAt,
            description: trans.__('%1 added a comment', event.comment.author.displayName),
            target: event.threadId,
            metadata: { comment: event.comment, threadId: event.threadId }
          });
        }
        break;
      
      case CommentChangeType.ReplyAdded:
        if (event.reply && event.commentId && event.threadId) {
          addActivity({
            type: 'comment',
            user: {
              id: event.reply.author.id,
              name: event.reply.author.displayName,
              avatar: event.reply.author.avatarUrl
            },
            timestamp: event.reply.createdAt,
            description: trans.__('%1 replied to a comment', event.reply.author.displayName),
            target: event.commentId,
            metadata: { reply: event.reply, commentId: event.commentId, threadId: event.threadId }
          });
        }
        break;
    }
  }, [addActivity, trans]);

  /**
   * Handle notification changes
   */
  const handleNotificationsChanged = useCallback((notifications: ICommentNotification[]) => {
    setState(prevState => ({
      ...prevState,
      notifications: notifications.filter(n => !n.read)
    }));
  }, []);

  /**
   * Toggle the activity feed expansion
   */
  const toggleActivityFeed = useCallback(() => {
    setState(prevState => ({
      ...prevState,
      isActivityFeedExpanded: !prevState.isActivityFeedExpanded
    }));
  }, []);

  /**
   * Toggle the user list expansion
   */
  const toggleUserList = useCallback(() => {
    setState(prevState => ({
      ...prevState,
      isUserListExpanded: !prevState.isUserListExpanded
    }));
  }, []);

  /**
   * Open the comments panel
   */
  const openCommentsPanel = useCallback(() => {
    // This would be implemented to open the comments panel
    console.log('Open comments panel');
  }, []);

  /**
   * Open the history viewer
   */
  const openHistoryViewer = useCallback(() => {
    // This would be implemented to open the history viewer
    console.log('Open history viewer');
  }, []);

  /**
   * Open the permissions dialog
   */
  const openPermissionsDialog = useCallback(() => {
    // This would be implemented to open the permissions dialog
    console.log('Open permissions dialog');
  }, []);

  /**
   * Mark all notifications as read
   */
  const markAllNotificationsAsRead = useCallback(() => {
    services.commentService.markAllNotificationsAsRead();
  }, [services.commentService]);

  // Connect to signals when the component mounts
  useEffect(() => {
    // Set up event listeners
    const awarenessService = services.awarenessService;
    const lockService = services.lockService;
    const commentService = services.commentService;
    
    // Initial state
    setState({
      users: awarenessService.getStates(),
      locks: lockService.getAllLocks(),
      activities: [],
      notifications: commentService.getUnreadNotifications(),
      isActivityFeedExpanded: false,
      isUserListExpanded: false,
      lockServiceStatus: lockService.status
    });
    
    // Connect to signals
    const awarenessChangedSlot = (awarenessService.stateChanged as ISignal<any, any>).connect(
      handleAwarenessChange
    );
    
    const lockAcquiredSlot = lockService.lockAcquired.connect(
      handleLockAcquired
    );
    
    const lockReleasedSlot = lockService.lockReleased.connect(
      handleLockReleased
    );
    
    const lockStatusChangedSlot = lockService.statusChanged.connect(
      handleLockStatusChanged
    );
    
    const commentChangedSlot = commentService.changed.connect(
      handleCommentChange
    );
    
    const notificationsChangedSlot = commentService.notificationsChanged.connect(
      handleNotificationsChanged
    );
    
    // Clean up event listeners when the component unmounts
    return () => {
      awarenessChangedSlot.disconnect();
      lockAcquiredSlot.disconnect();
      lockReleasedSlot.disconnect();
      lockStatusChangedSlot.disconnect();
      commentChangedSlot.disconnect();
      notificationsChangedSlot.disconnect();
    };
  }, [services, handleAwarenessChange, handleLockAcquired, handleLockReleased, 
      handleLockStatusChanged, handleCommentChange, handleNotificationsChanged]);

  // Visible users (limited in collapsed view)
  const visibleUsers = useMemo(() => {
    const users = Array.from(state.users.values());
    return state.isUserListExpanded ? users : users.slice(0, MAX_VISIBLE_USERS);
  }, [state.users, state.isUserListExpanded]);

  // Count of additional users not shown in collapsed view
  const additionalUsersCount = useMemo(() => {
    return Math.max(0, state.users.size - MAX_VISIBLE_USERS);
  }, [state.users]);

  // Render the collaboration bar
  return (
    <div className="jp-CollaborationBar">
      {/* Status indicator */}
      <div className="jp-CollaborationBar-status">
        <div className={`jp-CollaborationBar-statusIndicator jp-CollaborationBar-statusIndicator-${state.lockServiceStatus.toLowerCase()}`} />
        <span className="jp-CollaborationBar-statusText">
          {state.lockServiceStatus === LockManagerStatus.Ready
            ? trans.__('Connected')
            : state.lockServiceStatus === LockManagerStatus.Disconnected
            ? trans.__('Disconnected')
            : state.lockServiceStatus === LockManagerStatus.Degraded
            ? trans.__('Degraded')
            : trans.__('Initializing')}
        </span>
      </div>

      {/* User list */}
      <div className="jp-CollaborationBar-section jp-CollaborationBar-users">
        <div className="jp-CollaborationBar-sectionHeader" onClick={toggleUserList}>
          <span className="jp-CollaborationBar-sectionTitle">
            {trans.__('Collaborators (%1)', state.users.size)}
          </span>
          <button className="jp-CollaborationBar-expandButton">
            {state.isUserListExpanded ? '▼' : '►'}
          </button>
        </div>
        <div className={`jp-CollaborationBar-userList ${state.isUserListExpanded ? 'jp-CollaborationBar-expanded' : ''}`}>
          {visibleUsers.map((user, index) => (
            <div key={index} className="jp-CollaborationBar-user" title={user.user?.name || 'Unknown user'}>
              <div 
                className="jp-CollaborationBar-userAvatar"
                style={user.user?.avatar ? { backgroundImage: `url(${user.user.avatar})` } : {}}
              >
                {!user.user?.avatar && (user.user?.name?.[0] || '?')}
              </div>
              {state.isUserListExpanded && (
                <div className="jp-CollaborationBar-userName">
                  {user.user?.name || 'Unknown user'}
                </div>
              )}
            </div>
          ))}
          {additionalUsersCount > 0 && !state.isUserListExpanded && (
            <div className="jp-CollaborationBar-additionalUsers" title={trans.__('%1 more collaborators', additionalUsersCount)}>
              +{additionalUsersCount}
            </div>
          )}
        </div>
      </div>

      {/* Activity feed */}
      <div className="jp-CollaborationBar-section jp-CollaborationBar-activities">
        <div className="jp-CollaborationBar-sectionHeader" onClick={toggleActivityFeed}>
          <span className="jp-CollaborationBar-sectionTitle">
            {trans.__('Recent Activity')}
          </span>
          <button className="jp-CollaborationBar-expandButton">
            {state.isActivityFeedExpanded ? '▼' : '►'}
          </button>
        </div>
        <div className={`jp-CollaborationBar-activityFeed ${state.isActivityFeedExpanded ? 'jp-CollaborationBar-expanded' : ''}`}>
          {state.activities.length === 0 ? (
            <div className="jp-CollaborationBar-noActivities">
              {trans.__('No recent activity')}
            </div>
          ) : (
            state.activities.map((activity, index) => (
              <div key={index} className={`jp-CollaborationBar-activity jp-CollaborationBar-activity-${activity.type}`}>
                <div className="jp-CollaborationBar-activityHeader">
                  <div 
                    className="jp-CollaborationBar-activityAvatar"
                    style={activity.user.avatar ? { backgroundImage: `url(${activity.user.avatar})` } : {}}
                  >
                    {!activity.user.avatar && (activity.user.name[0] || '?')}
                  </div>
                  <div className="jp-CollaborationBar-activityUser">
                    {activity.user.name}
                  </div>
                  <div className="jp-CollaborationBar-activityTime">
                    {Time.formatHuman(new Date(activity.timestamp))}
                  </div>
                </div>
                <div className="jp-CollaborationBar-activityDescription">
                  {activity.description}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Quick access controls */}
      <div className="jp-CollaborationBar-controls">
        <button 
          className="jp-CollaborationBar-control jp-CollaborationBar-commentsButton"
          onClick={openCommentsPanel}
          title={trans.__('Comments')}
        >
          <div className="jp-CollaborationBar-controlIcon jp-CommentsIcon" />
          {state.notifications.length > 0 && (
            <div className="jp-CollaborationBar-notificationBadge">
              {state.notifications.length}
            </div>
          )}
        </button>
        <button 
          className="jp-CollaborationBar-control jp-CollaborationBar-historyButton"
          onClick={openHistoryViewer}
          title={trans.__('History')}
        >
          <div className="jp-CollaborationBar-controlIcon jp-HistoryIcon" />
        </button>
        <button 
          className="jp-CollaborationBar-control jp-CollaborationBar-permissionsButton"
          onClick={openPermissionsDialog}
          title={trans.__('Permissions')}
        >
          <div className="jp-CollaborationBar-controlIcon jp-PermissionsIcon" />
        </button>
      </div>
    </div>
  );
};

/**
 * A namespace for CollaborationBar statics.
 */
export namespace CollaborationBarComponent {
  /**
   * Create a new CollaborationBar widget
   */
  export function create({
    services,
    notebookTracker,
    translator
  }: {
    services: ICollaborationServices;
    notebookTracker: INotebookTracker;
    translator: ITranslator;
  }): ReactWidget {
    return ReactWidget.create(
      <CollaborationBar 
        services={services} 
        notebookTracker={notebookTracker} 
        translator={translator} 
      />
    );
  }
}

export default CollaborationBar;