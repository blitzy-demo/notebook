/**
 * @fileoverview Collaboration Bar component for Jupyter Notebook v7
 * 
 * This component serves as the primary collaboration interface in the notebook shell,
 * providing a comprehensive dashboard for real-time collaborative editing features.
 * It integrates with the Yjs CRDT framework to display active users, document sharing
 * status, recent activity feed, and provides access to collaboration controls.
 * 
 * Key features:
 * - Real-time display of active users with avatars and presence indicators
 * - Document sharing controls and permissions management access
 * - Live activity feed showing recent collaborative actions
 * - Collaboration status indicators and notifications
 * - Responsive design to handle varying numbers of collaborators
 * - Integration with all collaborative services (awareness, permissions, history, comments)
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';
import { NotebookPanel } from '@jupyterlab/notebook';
import { Time } from '@jupyterlab/coreutils';
import { ISignal } from '@lumino/signaling';

// Import collaborative services
import { AwarenessService } from '../../../notebook/src/collab/awareness';
import { PermissionService } from '../../../notebook/src/collab/permissions';
import { HistoryService } from '../../../notebook/src/collab/history';
import { CommentService } from '../../../notebook/src/collab/comments';

// Import UI components
import { PermissionsDialog } from './permissionsDialog';
import { UserPresence } from './userPresence';

/**
 * Interface for collaboration services used by the collaboration bar
 */
export interface ICollaborationServices {
  /** Awareness service for tracking user presence and collaborative states */
  awarenessService: AwarenessService;
  /** Permission service for managing user roles and access control */
  permissionService: PermissionService;
  /** History service for tracking document changes and activity feed */
  historyService: HistoryService;
  /** Comment service for managing notifications and collaborative events */
  commentService: CommentService;
}

/**
 * Props interface for the CollaborationBar component
 */
export interface ICollaborationBarProps {
  /** Collaborative services bundle */
  services: ICollaborationServices;
  /** Translator for internationalization */
  translator: ITranslator;
  /** Callback when permissions management is clicked */
  onPermissionsClick?: () => void;
  /** Callback when activity feed is clicked */
  onActivityClick?: () => void;
  /** Optional notebook panel for context */
  notebookPanel?: NotebookPanel;
  /** Whether to show detailed activity feed */
  showActivityFeed?: boolean;
  /** Maximum number of activities to display */
  maxActivities?: number;
  /** Whether to show collaboration status */
  showCollaborationStatus?: boolean;
}

/**
 * Interface for activity feed items
 */
interface IActivityItem {
  id: string;
  type: 'cell_added' | 'cell_deleted' | 'cell_modified' | 'cell_moved' | 'comment_added' | 'user_joined' | 'user_left';
  userName: string;
  userAvatar?: string;
  description: string;
  timestamp: Date;
  cellId?: string;
  userId: string;
}

/**
 * Interface for collaboration status
 */
interface ICollaborationStatus {
  isCollaborating: boolean;
  userCount: number;
  unreadComments: number;
  recentChanges: number;
  lastActivity: Date | null;
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
}

/**
 * Main collaboration bar component
 */
export const CollaborationBar: React.FC<ICollaborationBarProps> = ({
  services,
  translator,
  onPermissionsClick,
  onActivityClick,
  notebookPanel,
  showActivityFeed = true,
  maxActivities = 10,
  showCollaborationStatus = true
}) => {
  // State management
  const [collaborationStatus, setCollaborationStatus] = useState<ICollaborationStatus>({
    isCollaborating: false,
    userCount: 0,
    unreadComments: 0,
    recentChanges: 0,
    lastActivity: null,
    connectionStatus: 'connected'
  });
  
  const [activityFeed, setActivityFeed] = useState<IActivityItem[]>([]);
  const [isActivityExpanded, setIsActivityExpanded] = useState(false);
  const [isPermissionsDialogOpen, setIsPermissionsDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Refs for cleanup
  const signalConnectionsRef = useRef<Array<() => void>>([]);
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Translation helper
  const trans = translator.load('notebook-extension');
  
  /**
   * Update collaboration status from services
   */
  const updateCollaborationStatus = useCallback(async () => {
    try {
      const users = services.awarenessService.getUsers();
      const unreadComments = services.commentService.getUnreadComments();
      const recentActivity = await services.historyService.getRecentActivity(maxActivities);
      
      const now = new Date();
      const lastActivity = recentActivity.length > 0 ? recentActivity[0].timestamp : null;
      
      setCollaborationStatus({
        isCollaborating: users.length > 1,
        userCount: users.length,
        unreadComments: unreadComments.length,
        recentChanges: recentActivity.length,
        lastActivity,
        connectionStatus: 'connected' // TODO: Add actual connection status from services
      });
    } catch (error) {
      console.error('Error updating collaboration status:', error);
      setError(trans.__('Failed to update collaboration status'));
    }
  }, [services, maxActivities, trans]);
  
  /**
   * Update activity feed from history service
   */
  const updateActivityFeed = useCallback(async () => {
    try {
      const recentActivity = await services.historyService.getRecentActivity(maxActivities);
      const commentNotifications = services.commentService.getCommentNotifications();
      
      // Combine history and comment activities
      const activities: IActivityItem[] = [];
      
      // Add history activities
      recentActivity.forEach(activity => {
        activities.push({
          id: activity.id,
          type: activity.type,
          userName: activity.userName,
          userAvatar: undefined, // TODO: Get avatar from awareness service
          description: activity.description,
          timestamp: activity.timestamp,
          cellId: activity.cellId,
          userId: activity.userId
        });
      });
      
      // Add comment notifications as activities
      commentNotifications.slice(0, 5).forEach(notification => {
        if (notification.type === 'new_comment') {
          activities.push({
            id: notification.id,
            type: 'comment_added',
            userName: notification.message.split(' ')[0], // Extract username from message
            description: notification.message,
            timestamp: notification.timestamp,
            cellId: notification.cellId,
            userId: notification.user
          });
        }
      });
      
      // Sort by timestamp and limit
      activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      setActivityFeed(activities.slice(0, maxActivities));
    } catch (error) {
      console.error('Error updating activity feed:', error);
      setError(trans.__('Failed to update activity feed'));
    }
  }, [services, maxActivities, trans]);
  
  /**
   * Handle permissions dialog open
   */
  const handlePermissionsClick = useCallback(() => {
    setIsPermissionsDialogOpen(true);
    if (onPermissionsClick) {
      onPermissionsClick();
    }
  }, [onPermissionsClick]);
  
  /**
   * Handle activity feed toggle
   */
  const handleActivityClick = useCallback(() => {
    setIsActivityExpanded(!isActivityExpanded);
    if (onActivityClick) {
      onActivityClick();
    }
  }, [isActivityExpanded, onActivityClick]);
  
  /**
   * Handle user presence click
   */
  const handleUserPresenceClick = useCallback((user: any) => {
    // TODO: Implement user details or @mention functionality
    console.log('User clicked:', user);
  }, []);
  
  /**
   * Set up event listeners for real-time updates
   */
  useEffect(() => {
    const setupEventListeners = async () => {
      // Set up awareness service listeners
      const handleUserJoin = () => {
        updateCollaborationStatus();
        updateActivityFeed();
      };
      
      const handleUserLeave = () => {
        updateCollaborationStatus();
        updateActivityFeed();
      };
      
      const handleUserUpdate = () => {
        updateCollaborationStatus();
      };
      
      // Set up history service listeners
      const handleDocumentChange = () => {
        updateActivityFeed();
        updateCollaborationStatus();
      };
      
      // Set up comment service listeners
      const handleNewComment = () => {
        updateActivityFeed();
        updateCollaborationStatus();
      };
      
      const handleCommentResolved = () => {
        updateActivityFeed();
        updateCollaborationStatus();
      };
      
      // Connect to services
      services.awarenessService.onUserJoin.connect(handleUserJoin);
      services.awarenessService.onUserLeave.connect(handleUserLeave);
      services.awarenessService.onUserUpdate.connect(handleUserUpdate);
      services.historyService.onDocumentChange.connect(handleDocumentChange);
      services.commentService.onNewComment.connect(handleNewComment);
      services.commentService.onCommentResolved.connect(handleCommentResolved);
      
      // Store cleanup functions
      signalConnectionsRef.current.push(
        () => services.awarenessService.onUserJoin.disconnect(handleUserJoin),
        () => services.awarenessService.onUserLeave.disconnect(handleUserLeave),
        () => services.awarenessService.onUserUpdate.disconnect(handleUserUpdate),
        () => services.historyService.onDocumentChange.disconnect(handleDocumentChange),
        () => services.commentService.onNewComment.disconnect(handleNewComment),
        () => services.commentService.onCommentResolved.disconnect(handleCommentResolved)
      );
      
      // Initial update
      await updateCollaborationStatus();
      await updateActivityFeed();
    };
    
    setupEventListeners();
    
    // Set up periodic updates
    const interval = setInterval(() => {
      updateCollaborationStatus();
      updateActivityFeed();
    }, 30000); // Update every 30 seconds
    
    return () => {
      // Cleanup signal connections
      signalConnectionsRef.current.forEach(cleanup => cleanup());
      signalConnectionsRef.current = [];
      
      // Clear intervals and timeouts
      clearInterval(interval);
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, [services, updateCollaborationStatus, updateActivityFeed]);
  
  /**
   * Clear error messages after delay
   */
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => {
        setError(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);
  
  /**
   * Format activity description for display
   */
  const formatActivityDescription = (activity: IActivityItem): string => {
    const timeStr = Time.formatHuman(activity.timestamp);
    return `${activity.description} ${timeStr}`;
  };
  
  /**
   * Get status indicator color
   */
  const getStatusColor = (status: ICollaborationStatus): string => {
    if (status.connectionStatus === 'disconnected') return '#f44336'; // Red
    if (status.connectionStatus === 'reconnecting') return '#ff9800'; // Orange
    if (status.isCollaborating) return '#4caf50'; // Green
    return '#9e9e9e'; // Gray
  };
  
  /**
   * Get collaboration status text
   */
  const getStatusText = (status: ICollaborationStatus): string => {
    if (status.connectionStatus === 'disconnected') {
      return trans.__('Disconnected');
    }
    if (status.connectionStatus === 'reconnecting') {
      return trans.__('Reconnecting...');
    }
    if (status.isCollaborating) {
      return trans.__('Collaborating with %1 users', status.userCount);
    }
    return trans.__('Solo editing');
  };
  
  return (
    <div className="jp-CollaborationBar">
      {/* Error message */}
      {error && (
        <div className="jp-CollaborationBar-error">
          {error}
        </div>
      )}
      
      {/* Main collaboration bar content */}
      <div className="jp-CollaborationBar-content">
        {/* Collaboration status indicator */}
        {showCollaborationStatus && (
          <div className="jp-CollaborationBar-status">
            <div
              className="jp-CollaborationBar-statusIndicator"
              style={{ backgroundColor: getStatusColor(collaborationStatus) }}
              title={getStatusText(collaborationStatus)}
            />
            <span className="jp-CollaborationBar-statusText">
              {getStatusText(collaborationStatus)}
            </span>
            {collaborationStatus.unreadComments > 0 && (
              <span className="jp-CollaborationBar-badge">
                {collaborationStatus.unreadComments}
              </span>
            )}
          </div>
        )}
        
        {/* User presence component */}
        <div className="jp-CollaborationBar-users">
          <UserPresence
            awarenessService={services.awarenessService}
            permissionService={services.permissionService}
            translator={translator}
            maxUsers={8}
            showRoles={true}
            showActivity={true}
            onUserClick={handleUserPresenceClick}
          />
        </div>
        
        {/* Action buttons */}
        <div className="jp-CollaborationBar-actions">
          {/* Permissions button */}
          <button
            className="jp-CollaborationBar-button"
            onClick={handlePermissionsClick}
            title={trans.__('Manage permissions')}
            disabled={isLoading}
          >
            <span className="jp-CollaborationBar-buttonIcon">👥</span>
            <span className="jp-CollaborationBar-buttonText">
              {trans.__('Share')}
            </span>
          </button>
          
          {/* Activity feed button */}
          {showActivityFeed && (
            <button
              className="jp-CollaborationBar-button"
              onClick={handleActivityClick}
              title={trans.__('Show activity feed')}
              disabled={isLoading}
            >
              <span className="jp-CollaborationBar-buttonIcon">📝</span>
              <span className="jp-CollaborationBar-buttonText">
                {trans.__('Activity')}
              </span>
              {collaborationStatus.recentChanges > 0 && (
                <span className="jp-CollaborationBar-badge">
                  {collaborationStatus.recentChanges}
                </span>
              )}
            </button>
          )}
        </div>
      </div>
      
      {/* Expanded activity feed */}
      {isActivityExpanded && showActivityFeed && (
        <div className="jp-CollaborationBar-activityFeed">
          <div className="jp-CollaborationBar-activityHeader">
            <h3>{trans.__('Recent Activity')}</h3>
            <button
              className="jp-CollaborationBar-closeButton"
              onClick={() => setIsActivityExpanded(false)}
              title={trans.__('Close activity feed')}
            >
              ×
            </button>
          </div>
          <div className="jp-CollaborationBar-activityList">
            {activityFeed.length === 0 ? (
              <div className="jp-CollaborationBar-emptyActivity">
                {trans.__('No recent activity')}
              </div>
            ) : (
              activityFeed.map(activity => (
                <div key={activity.id} className="jp-CollaborationBar-activityItem">
                  <div className="jp-CollaborationBar-activityIcon">
                    {activity.type === 'cell_added' && '➕'}
                    {activity.type === 'cell_deleted' && '🗑️'}
                    {activity.type === 'cell_modified' && '✏️'}
                    {activity.type === 'cell_moved' && '🔄'}
                    {activity.type === 'comment_added' && '💬'}
                    {activity.type === 'user_joined' && '👋'}
                    {activity.type === 'user_left' && '👋'}
                  </div>
                  <div className="jp-CollaborationBar-activityContent">
                    <div className="jp-CollaborationBar-activityDescription">
                      {formatActivityDescription(activity)}
                    </div>
                    <div className="jp-CollaborationBar-activityMeta">
                      <span className="jp-CollaborationBar-activityUser">
                        {activity.userName}
                      </span>
                      {activity.cellId && (
                        <span className="jp-CollaborationBar-activityCell">
                          {trans.__('in cell %1', activity.cellId.slice(0, 8))}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      
      {/* Permissions dialog */}
      {isPermissionsDialogOpen && notebookPanel && (
        <PermissionsDialog
          notebookModel={notebookPanel.content.model}
          permissionService={services.permissionService}
          awarenessService={services.awarenessService}
          translator={translator}
          onPermissionsChanged={() => {
            updateCollaborationStatus();
          }}
          onDialogClosed={() => {
            setIsPermissionsDialogOpen(false);
          }}
        />
      )}
    </div>
  );
};

/**
 * Lumino widget wrapper for the collaboration bar
 */
export class CollaborationBarWidget extends ReactWidget {
  private _services: ICollaborationServices;
  private _translator: ITranslator;
  private _onPermissionsClick?: () => void;
  private _onActivityClick?: () => void;
  private _notebookPanel?: NotebookPanel;
  private _showActivityFeed: boolean;
  private _maxActivities: number;
  private _showCollaborationStatus: boolean;
  
  constructor(options: {
    services: ICollaborationServices;
    translator: ITranslator;
    onPermissionsClick?: () => void;
    onActivityClick?: () => void;
    notebookPanel?: NotebookPanel;
    showActivityFeed?: boolean;
    maxActivities?: number;
    showCollaborationStatus?: boolean;
  }) {
    super();
    this._services = options.services;
    this._translator = options.translator;
    this._onPermissionsClick = options.onPermissionsClick;
    this._onActivityClick = options.onActivityClick;
    this._notebookPanel = options.notebookPanel;
    this._showActivityFeed = options.showActivityFeed !== false;
    this._maxActivities = options.maxActivities || 10;
    this._showCollaborationStatus = options.showCollaborationStatus !== false;
    
    this.addClass('jp-CollaborationBarWidget');
    this.title.label = 'Collaboration Bar';
    this.title.iconClass = 'jp-CollaborationIcon';
  }
  
  /**
   * Create a new collaboration bar widget
   */
  static create(options: {
    services: ICollaborationServices;
    translator: ITranslator;
    onPermissionsClick?: () => void;
    onActivityClick?: () => void;
    notebookPanel?: NotebookPanel;
    showActivityFeed?: boolean;
    maxActivities?: number;
    showCollaborationStatus?: boolean;
  }): CollaborationBarWidget {
    return new CollaborationBarWidget(options);
  }
  
  /**
   * Update the widget configuration
   */
  update(options?: Partial<{
    onPermissionsClick: () => void;
    onActivityClick: () => void;
    notebookPanel: NotebookPanel;
    showActivityFeed: boolean;
    maxActivities: number;
    showCollaborationStatus: boolean;
  }>): void {
    if (options) {
      if (options.onPermissionsClick !== undefined) {
        this._onPermissionsClick = options.onPermissionsClick;
      }
      if (options.onActivityClick !== undefined) {
        this._onActivityClick = options.onActivityClick;
      }
      if (options.notebookPanel !== undefined) {
        this._notebookPanel = options.notebookPanel;
      }
      if (options.showActivityFeed !== undefined) {
        this._showActivityFeed = options.showActivityFeed;
      }
      if (options.maxActivities !== undefined) {
        this._maxActivities = options.maxActivities;
      }
      if (options.showCollaborationStatus !== undefined) {
        this._showCollaborationStatus = options.showCollaborationStatus;
      }
    }
    
    super.update();
  }
  
  /**
   * Dispose of the widget
   */
  dispose(): void {
    // Clean up any resources
    super.dispose();
  }
  
  /**
   * Render the React component
   */
  render(): JSX.Element {
    return (
      <CollaborationBar
        services={this._services}
        translator={this._translator}
        onPermissionsClick={this._onPermissionsClick}
        onActivityClick={this._onActivityClick}
        notebookPanel={this._notebookPanel}
        showActivityFeed={this._showActivityFeed}
        maxActivities={this._maxActivities}
        showCollaborationStatus={this._showCollaborationStatus}
      />
    );
  }
}

/*
 * CSS Styles for the collaboration bar component
 * These styles provide a modern, professional interface for collaboration features
 */
const CSS_STYLES = `
<style>
.jp-CollaborationBar {
  display: flex;
  flex-direction: column;
  font-family: var(--jp-ui-font-family);
  font-size: var(--jp-ui-font-size1);
  border-bottom: 1px solid var(--jp-border-color1);
  background: var(--jp-layout-color1);
  min-height: 48px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  position: relative;
  z-index: 1000;
}

.jp-CollaborationBar-error {
  background: var(--jp-error-color3);
  color: var(--jp-error-color1);
  border: 1px solid var(--jp-error-color2);
  padding: 8px 12px;
  margin: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  animation: slideDown 0.3s ease-out;
}

.jp-CollaborationBar-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  gap: 16px;
  flex-wrap: wrap;
  min-height: 40px;
}

.jp-CollaborationBar-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--jp-layout-color2);
  min-width: 120px;
  position: relative;
}

.jp-CollaborationBar-statusIndicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background-color 0.3s ease;
}

.jp-CollaborationBar-statusText {
  font-size: 12px;
  font-weight: 500;
  color: var(--jp-ui-font-color1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jp-CollaborationBar-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  background: var(--jp-brand-color1);
  color: white;
  border-radius: 50%;
  min-width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: bold;
  border: 2px solid var(--jp-layout-color1);
  animation: pulse 2s infinite;
}

.jp-CollaborationBar-users {
  flex: 1;
  display: flex;
  justify-content: center;
  max-width: 400px;
  margin: 0 auto;
}

.jp-CollaborationBar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.jp-CollaborationBar-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  min-width: 80px;
  justify-content: center;
}

.jp-CollaborationBar-button:hover:not(:disabled) {
  background: var(--jp-layout-color2);
  border-color: var(--jp-brand-color1);
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.jp-CollaborationBar-button:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.jp-CollaborationBar-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.jp-CollaborationBar-buttonIcon {
  font-size: 14px;
  line-height: 1;
}

.jp-CollaborationBar-buttonText {
  font-size: 12px;
  font-weight: 500;
}

.jp-CollaborationBar-activityFeed {
  position: absolute;
  top: 100%;
  right: 16px;
  width: 320px;
  max-height: 400px;
  background: var(--jp-layout-color1);
  border: 1px solid var(--jp-border-color1);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1001;
  animation: slideDown 0.3s ease-out;
  overflow: hidden;
}

.jp-CollaborationBar-activityHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--jp-border-color1);
  background: var(--jp-layout-color2);
}

.jp-CollaborationBar-activityHeader h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--jp-ui-font-color1);
}

.jp-CollaborationBar-closeButton {
  background: none;
  border: none;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: var(--jp-ui-font-color2);
  padding: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  transition: all 0.2s ease;
}

.jp-CollaborationBar-closeButton:hover {
  background: var(--jp-layout-color3);
  color: var(--jp-ui-font-color1);
}

.jp-CollaborationBar-activityList {
  max-height: 340px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--jp-scrollbar-thumb-color) var(--jp-scrollbar-track-color);
}

.jp-CollaborationBar-activityList::-webkit-scrollbar {
  width: 6px;
}

.jp-CollaborationBar-activityList::-webkit-scrollbar-track {
  background: var(--jp-scrollbar-track-color);
}

.jp-CollaborationBar-activityList::-webkit-scrollbar-thumb {
  background: var(--jp-scrollbar-thumb-color);
  border-radius: 3px;
}

.jp-CollaborationBar-activityItem {
  display: flex;
  align-items: flex-start;
  padding: 12px 16px;
  border-bottom: 1px solid var(--jp-border-color2);
  gap: 12px;
  transition: background-color 0.2s ease;
}

.jp-CollaborationBar-activityItem:hover {
  background: var(--jp-layout-color2);
}

.jp-CollaborationBar-activityItem:last-child {
  border-bottom: none;
}

.jp-CollaborationBar-activityIcon {
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
  margin-top: 2px;
}

.jp-CollaborationBar-activityContent {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.jp-CollaborationBar-activityDescription {
  font-size: 13px;
  color: var(--jp-ui-font-color1);
  line-height: 1.4;
}

.jp-CollaborationBar-activityMeta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.jp-CollaborationBar-activityUser {
  font-size: 11px;
  color: var(--jp-ui-font-color2);
  font-weight: 500;
}

.jp-CollaborationBar-activityCell {
  font-size: 11px;
  color: var(--jp-ui-font-color2);
  background: var(--jp-layout-color3);
  padding: 2px 6px;
  border-radius: 3px;
  font-family: var(--jp-code-font-family);
}

.jp-CollaborationBar-emptyActivity {
  padding: 40px 16px;
  text-align: center;
  color: var(--jp-ui-font-color2);
  font-size: 13px;
  font-style: italic;
}

/* Responsive design */
@media (max-width: 768px) {
  .jp-CollaborationBar-content {
    flex-direction: column;
    gap: 12px;
    padding: 12px 16px;
  }
  
  .jp-CollaborationBar-status {
    order: 2;
    min-width: auto;
    width: 100%;
    justify-content: center;
  }
  
  .jp-CollaborationBar-users {
    order: 1;
    max-width: 100%;
  }
  
  .jp-CollaborationBar-actions {
    order: 3;
    justify-content: center;
    width: 100%;
  }
  
  .jp-CollaborationBar-activityFeed {
    right: 8px;
    left: 8px;
    width: auto;
  }
}

@media (max-width: 480px) {
  .jp-CollaborationBar-content {
    padding: 8px 12px;
  }
  
  .jp-CollaborationBar-actions {
    flex-direction: column;
    gap: 6px;
  }
  
  .jp-CollaborationBar-button {
    width: 100%;
    min-width: 120px;
  }
  
  .jp-CollaborationBar-activityFeed {
    right: 4px;
    left: 4px;
  }
}

/* Animations */
@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes pulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(1);
  }
}

/* Dark theme adjustments */
.jp-mod-dark .jp-CollaborationBar {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.jp-mod-dark .jp-CollaborationBar-activityFeed {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

/* High contrast mode */
@media (prefers-contrast: high) {
  .jp-CollaborationBar-statusIndicator {
    border: 1px solid var(--jp-ui-font-color1);
  }
  
  .jp-CollaborationBar-button {
    border-width: 2px;
  }
  
  .jp-CollaborationBar-badge {
    border-width: 3px;
  }
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  .jp-CollaborationBar-button {
    transition: none;
  }
  
  .jp-CollaborationBar-statusIndicator {
    transition: none;
  }
  
  .jp-CollaborationBar-badge {
    animation: none;
  }
  
  .jp-CollaborationBar-activityFeed {
    animation: none;
  }
}

/* Widget-specific styles */
.jp-CollaborationBarWidget {
  background: var(--jp-layout-color1);
  border-bottom: 1px solid var(--jp-border-color1);
}

.jp-CollaborationBarWidget .jp-CollaborationBar {
  border-bottom: none;
}
</style>
`;

// Inject styles into the document
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = CSS_STYLES.replace(/<\/?style>/g, '');
  document.head.appendChild(styleElement);
}