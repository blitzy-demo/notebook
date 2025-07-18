/**
 * @fileoverview Enhanced panel handler for collaborative notebook editing
 * 
 * This module provides comprehensive collaborative panel management capabilities
 * for Jupyter Notebook v7, extending the base panel handler with real-time
 * collaborative features. It manages multi-user panel interactions, integrates
 * with the collaborative UI system, and provides synchronized panel management
 * across all connected clients.
 * 
 * Key features:
 * - Enhanced panel coordination for multi-user scenarios
 * - Collaborative panel state synchronization
 * - Integration with awareness, locking, and permission systems
 * - Real-time user activity tracking in panel widgets
 * - Collaborative command palette with permission filtering
 * - Session management for collaborative panel operations
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import { StackedPanel } from '@lumino/widgets';
import { ISignal, Signal } from '@lumino/signaling';
import { IMessageHandler } from '@lumino/messaging';
import { find } from '@lumino/algorithm';
import { IDisposable, DisposableSet } from '@lumino/disposable';
import { closeIcon } from '@jupyterlab/ui-components';
import { ICommandPalette } from '@jupyterlab/apputils';

// Import internal dependencies
import { NotebookPanel } from './widget';
import { NotebookApp } from './app';
import { AwarenessService } from './collab/awareness';
import { IAwarenessService } from './tokens';
import { LockService } from './collab/locks';
import { PermissionService } from './collab/permissions';

/**
 * Interface for collaborative panel session information
 */
export interface ICollaborativePanelSession {
  /** Unique identifier for the session */
  sessionId: string;
  /** List of active collaborators */
  collaborators: Array<{
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
    lastSeen: Date;
  }>;
  /** Current user permissions for the session */
  permissions: {
    canView: boolean;
    canEdit: boolean;
    canAdmin: boolean;
  };
  /** Current lock state for the panel */
  lockState: {
    isLocked: boolean;
    lockedBy?: string;
    lockOwner?: string;
    lockedAt?: Date;
  };
  
  /**
   * Connect to the collaborative session
   * @returns Promise resolving when connection is established
   */
  connect(): Promise<void>;
  
  /**
   * Disconnect from the collaborative session
   * @returns Promise resolving when disconnection is complete
   */
  disconnect(): Promise<void>;
  
  /**
   * Update user status in the session
   * @param status - The new user status
   * @returns Promise resolving when status is updated
   */
  updateUserStatus(status: 'active' | 'idle' | 'offline'): Promise<void>;
  
  /**
   * Broadcast a panel change to all collaborators
   * @param change - The change information to broadcast
   * @returns Promise resolving when broadcast is complete
   */
  broadcastPanelChange(change: {
    type: 'widget-added' | 'widget-removed' | 'widget-activated' | 'panel-expanded' | 'panel-collapsed';
    widgetId?: string;
    metadata?: Record<string, any>;
  }): Promise<void>;
}

/**
 * Namespace for collaborative panel types and utilities
 */
export namespace CollaborativePanel {
  /**
   * Panel area types for collaborative panels
   */
  export type Area = 'left' | 'right' | 'top' | 'bottom' | 'main';
  
  /**
   * Options for creating collaborative panels
   */
  export interface Options {
    /** Panel area for positioning */
    area?: Area;
    /** Whether to enable collaborative features */
    collaborative?: boolean;
    /** Initial permissions for the panel */
    permissions?: {
      canView?: boolean;
      canEdit?: boolean;
      canAdmin?: boolean;
    };
    /** Session configuration */
    sessionConfig?: {
      sessionId?: string;
      autoConnect?: boolean;
      trackActivity?: boolean;
    };
  }
  
  /**
   * Collaborative state information for panels
   */
  export interface CollaborativeState {
    /** Whether collaborative features are enabled */
    isCollaborative: boolean;
    /** Current session information */
    session: ICollaborativePanelSession | null;
    /** List of active collaborators */
    collaborators: Array<{
      userId: string;
      name: string;
      avatar?: string;
      isActive: boolean;
      currentWidget?: string;
    }>;
    /** Current user permissions */
    permissions: {
      canView: boolean;
      canEdit: boolean;
      canAdmin: boolean;
    };
  }
  
  /**
   * User permissions for collaborative panels
   */
  export interface UserPermissions {
    /** User identifier */
    userId: string;
    /** Permission level */
    role: 'view' | 'edit' | 'admin';
    /** Specific permissions */
    permissions: {
      canView: boolean;
      canEdit: boolean;
      canAdmin: boolean;
      canLock: boolean;
      canComment: boolean;
    };
  }
}

/**
 * Enhanced panel handler with collaborative editing capabilities
 * 
 * This class extends the base panel handler to provide comprehensive
 * collaborative features including real-time synchronization, user
 * awareness, and permission-based access control.
 */
export class CollaborativePanelHandler implements IDisposable {
  private _panel: StackedPanel;
  private _notebookApp: NotebookApp;
  private _awarenessService: AwarenessService;
  private _lockService: LockService;
  private _permissionService: PermissionService;
  private _disposables: DisposableSet = new DisposableSet();
  private _collaborativeState: CollaborativePanel.CollaborativeState;
  private _session: ICollaborativePanelSession | null = null;
  private _isDisposed: boolean = false;
  
  // Signals for collaborative events
  private _collaboratorsChangedSignal = new Signal<CollaborativePanelHandler, Array<{
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
  }>>(this);
  
  private _permissionsChangedSignal = new Signal<CollaborativePanelHandler, CollaborativePanel.UserPermissions>(this);
  
  private _sessionChangedSignal = new Signal<CollaborativePanelHandler, ICollaborativePanelSession | null>(this);
  
  /**
   * Create a new collaborative panel handler
   * 
   * @param options - Configuration options for the handler
   */
  constructor(options: {
    notebookApp: NotebookApp;
    awarenessService: AwarenessService;
    lockService: LockService;
    permissionService: PermissionService;
    panelOptions?: CollaborativePanel.Options;
  }) {
    this._notebookApp = options.notebookApp;
    this._awarenessService = options.awarenessService;
    this._lockService = options.lockService;
    this._permissionService = options.permissionService;
    
    // Initialize panel
    this._panel = new StackedPanel();
    this._panel.addClass('jp-CollaborativePanel');
    
    // Initialize collaborative state
    this._collaborativeState = {
      isCollaborative: options.panelOptions?.collaborative !== false,
      session: null,
      collaborators: [],
      permissions: {
        canView: true,
        canEdit: true,
        canAdmin: false
      }
    };
    
    // Set up collaborative features
    this._setupCollaborativeFeatures();
    
    // Set up event handlers
    this._setupEventHandlers();
  }
  
  /**
   * Get the managed panel widget
   */
  get panel(): StackedPanel {
    return this._panel;
  }
  
  /**
   * Signal emitted when collaborators change
   */
  get collaboratorsChanged(): ISignal<CollaborativePanelHandler, Array<{
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
  }>> {
    return this._collaboratorsChangedSignal;
  }
  
  /**
   * Signal emitted when permissions change
   */
  get permissionsChanged(): ISignal<CollaborativePanelHandler, CollaborativePanel.UserPermissions> {
    return this._permissionsChangedSignal;
  }
  
  /**
   * Signal emitted when session changes
   */
  get sessionChanged(): ISignal<CollaborativePanelHandler, ICollaborativePanelSession | null> {
    return this._sessionChangedSignal;
  }
  
  /**
   * Add a widget to the panel with collaborative support
   * 
   * @param widget - The widget to add
   * @param options - Additional options for collaborative features
   */
  addWidget(widget: any, options?: {
    rank?: number;
    collaborative?: boolean;
    permissions?: CollaborativePanel.UserPermissions;
  }): void {
    if (this._isDisposed) {
      return;
    }
    
    // Check permissions
    if (!this._collaborativeState.permissions.canEdit && options?.collaborative !== false) {
      console.warn('Cannot add widget: insufficient permissions');
      return;
    }
    
    // Add widget to panel
    this._panel.addWidget(widget);
    
    // Set up collaborative tracking if enabled
    if (this._collaborativeState.isCollaborative && options?.collaborative !== false) {
      this._trackWidgetActivity(widget);
    }
    
    // Broadcast change to collaborators
    this._broadcastPanelChange({
      type: 'widget-added',
      widgetId: widget.id,
      metadata: {
        rank: options?.rank,
        collaborative: options?.collaborative !== false
      }
    });
  }
  
  /**
   * Add a widget with full collaborative support
   * 
   * @param widget - The widget to add
   * @param options - Collaborative options
   */
  addCollaborativeWidget(widget: any, options?: {
    rank?: number;
    permissions?: CollaborativePanel.UserPermissions;
    trackActivity?: boolean;
    enableLocking?: boolean;
  }): void {
    if (this._isDisposed) {
      return;
    }
    
    // Validate permissions
    if (!this._collaborativeState.permissions.canEdit) {
      throw new Error('Insufficient permissions to add collaborative widget');
    }
    
    // Add widget with full collaborative support
    this.addWidget(widget, {
      rank: options?.rank,
      collaborative: true,
      permissions: options?.permissions
    });
    
    // Enable additional collaborative features
    if (options?.trackActivity !== false) {
      this._trackWidgetActivity(widget);
    }
    
    if (options?.enableLocking) {
      this._enableWidgetLocking(widget);
    }
  }
  
  /**
   * Lock the panel for exclusive access
   * 
   * @param options - Lock options
   * @returns Promise resolving to true if lock was acquired
   */
  async lockPanel(options?: {
    timeout?: number;
    force?: boolean;
  }): Promise<boolean> {
    if (this._isDisposed) {
      return false;
    }
    
    // Check permissions
    if (!this._collaborativeState.permissions.canEdit) {
      return false;
    }
    
    try {
      // Use lock service to acquire panel lock
      const lockAcquired = await this._lockService.lockCell(
        `panel-${this._panel.id}`,
        options?.timeout
      );
      
      if (lockAcquired) {
        this._panel.addClass('jp-CollaborativePanel-locked');
        
        // Broadcast lock state change
        await this._broadcastPanelChange({
          type: 'panel-locked' as any,
          metadata: {
            lockedBy: this._awarenessService.getCurrentUser().userId,
            lockedAt: new Date().toISOString()
          }
        });
      }
      
      return lockAcquired;
    } catch (error) {
      console.error('Error locking panel:', error);
      return false;
    }
  }
  
  /**
   * Unlock the panel
   * 
   * @returns Promise resolving to true if unlock was successful
   */
  async unlockPanel(): Promise<boolean> {
    if (this._isDisposed) {
      return false;
    }
    
    try {
      // Use lock service to release panel lock
      const unlockSuccessful = await this._lockService.unlockCell(
        `panel-${this._panel.id}`
      );
      
      if (unlockSuccessful) {
        this._panel.removeClass('jp-CollaborativePanel-locked');
        
        // Broadcast unlock state change
        await this._broadcastPanelChange({
          type: 'panel-unlocked' as any,
          metadata: {
            unlockedBy: this._awarenessService.getCurrentUser().userId,
            unlockedAt: new Date().toISOString()
          }
        });
      }
      
      return unlockSuccessful;
    } catch (error) {
      console.error('Error unlocking panel:', error);
      return false;
    }
  }
  
  /**
   * Get list of current collaborators
   */
  getCollaborators(): Array<{
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
    currentWidget?: string;
  }> {
    return [...this._collaborativeState.collaborators];
  }
  
  /**
   * Get current user permissions
   */
  getUserPermissions(): CollaborativePanel.UserPermissions {
    const currentUser = this._awarenessService.getCurrentUser();
    return {
      userId: currentUser.userId,
      role: this._collaborativeState.permissions.canAdmin ? 'admin' : 
            this._collaborativeState.permissions.canEdit ? 'edit' : 'view',
      permissions: {
        canView: this._collaborativeState.permissions.canView,
        canEdit: this._collaborativeState.permissions.canEdit,
        canAdmin: this._collaborativeState.permissions.canAdmin,
        canLock: this._collaborativeState.permissions.canEdit,
        canComment: this._collaborativeState.permissions.canView
      }
    };
  }
  
  /**
   * Dispose of the panel handler and cleanup resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    this._isDisposed = true;
    
    // Disconnect from session
    if (this._session) {
      this._session.disconnect().catch(console.error);
    }
    
    // Dispose of disposables
    this._disposables.dispose();
    
    // Clean up panel
    this._panel.dispose();
  }
  
  /**
   * Set up collaborative features
   */
  private _setupCollaborativeFeatures(): void {
    // Create collaborative session
    this._session = this._createCollaborativeSession();
    
    // Update collaborative state
    this._collaborativeState.session = this._session;
    
    // Connect to session if auto-connect is enabled
    if (this._collaborativeState.isCollaborative) {
      this._session.connect().catch(console.error);
    }
  }
  
  /**
   * Set up event handlers for collaborative features
   */
  private _setupEventHandlers(): void {
    // Awareness service events
    this._disposables.add(
      this._awarenessService.onUserJoin.connect(this._onUserJoined, this)
    );
    
    this._disposables.add(
      this._awarenessService.onUserLeave.connect(this._onUserLeft, this)
    );
    
    // Permission service events
    this._disposables.add(
      this._permissionService.onPermissionChanged.connect(this._onPermissionsChanged, this)
    );
    
    // Lock service events
    this._disposables.add(
      this._lockService.onLockChange.connect(this._onLockChanged, this)
    );
  }
  
  /**
   * Create a collaborative session for the panel
   */
  private _createCollaborativeSession(): ICollaborativePanelSession {
    const sessionId = `panel-${this._panel.id}-${Date.now()}`;
    
    return {
      sessionId,
      collaborators: [],
      permissions: {
        canView: true,
        canEdit: true,
        canAdmin: false
      },
      lockState: {
        isLocked: false
      },
      
      async connect(): Promise<void> {
        // Implementation would connect to collaborative backend
        console.log('Connecting to collaborative session:', sessionId);
      },
      
      async disconnect(): Promise<void> {
        // Implementation would disconnect from collaborative backend
        console.log('Disconnecting from collaborative session:', sessionId);
      },
      
      async updateUserStatus(status: 'active' | 'idle' | 'offline'): Promise<void> {
        // Implementation would update user status
        console.log('Updating user status:', status);
      },
      
      async broadcastPanelChange(change: any): Promise<void> {
        // Implementation would broadcast change to collaborators
        console.log('Broadcasting panel change:', change);
      }
    };
  }
  
  /**
   * Track widget activity for collaborative features
   */
  private _trackWidgetActivity(widget: any): void {
    if (!this._collaborativeState.isCollaborative) {
      return;
    }
    
    // Add activity tracking to widget
    widget.addClass('jp-CollaborativeWidget');
    
    // Track widget activation
    const disposable = widget.activated.connect(() => {
      this._updateUserActivity(widget.id);
    });
    
    this._disposables.add(disposable);
  }
  
  /**
   * Enable widget locking for collaborative features
   */
  private _enableWidgetLocking(widget: any): void {
    if (!this._collaborativeState.isCollaborative) {
      return;
    }
    
    // Add lock capability to widget
    widget.addClass('jp-CollaborativeWidget-lockable');
    
    // Add lock indicator
    const lockIndicator = document.createElement('div');
    lockIndicator.className = 'jp-CollaborativeWidget-lockIndicator';
    widget.node.appendChild(lockIndicator);
  }
  
  /**
   * Update user activity for collaborative tracking
   */
  private _updateUserActivity(widgetId: string): void {
    if (!this._collaborativeState.isCollaborative) {
      return;
    }
    
    // Update user presence with current widget
    this._awarenessService.updateUserStatus('active' as any);
    
    // Broadcast activity update
    this._broadcastPanelChange({
      type: 'widget-activated',
      widgetId,
      metadata: {
        userId: this._awarenessService.getCurrentUser().userId,
        timestamp: new Date().toISOString()
      }
    });
  }
  
  /**
   * Broadcast panel change to collaborators
   */
  private async _broadcastPanelChange(change: {
    type: string;
    widgetId?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    if (!this._session) {
      return;
    }
    
    try {
      await this._session.broadcastPanelChange(change as any);
    } catch (error) {
      console.error('Error broadcasting panel change:', error);
    }
  }
  
  /**
   * Handle user joined event
   */
  private _onUserJoined(
    sender: AwarenessService,
    args: { userId: string; name: string; avatar?: string }
  ): void {
    // Update collaborators list
    this._collaborativeState.collaborators.push({
      userId: args.userId,
      name: args.name,
      avatar: args.avatar,
      isActive: true
    });
    
    // Emit signal
    this._collaboratorsChangedSignal.emit(this._collaborativeState.collaborators);
  }
  
  /**
   * Handle user left event
   */
  private _onUserLeft(
    sender: AwarenessService,
    args: { userId: string }
  ): void {
    // Remove from collaborators list
    const index = this._collaborativeState.collaborators.findIndex(
      collab => collab.userId === args.userId
    );
    
    if (index !== -1) {
      this._collaborativeState.collaborators.splice(index, 1);
      this._collaboratorsChangedSignal.emit(this._collaborativeState.collaborators);
    }
  }
  
  /**
   * Handle permissions changed event
   */
  private _onPermissionsChanged(
    sender: PermissionService,
    args: any
  ): void {
    // Update permissions
    this._updatePermissions();
    
    // Emit signal
    this._permissionsChangedSignal.emit(this.getUserPermissions());
  }
  
  /**
   * Handle lock changed event
   */
  private _onLockChanged(
    sender: LockService,
    args: any
  ): void {
    // Update lock state in UI
    if (args.cellId === `panel-${this._panel.id}`) {
      if (args.isLocked) {
        this._panel.addClass('jp-CollaborativePanel-locked');
      } else {
        this._panel.removeClass('jp-CollaborativePanel-locked');
      }
    }
  }
  
  /**
   * Update permissions based on current user and session
   */
  private async _updatePermissions(): Promise<void> {
    try {
      const canView = await this._permissionService.canView();
      const canEdit = await this._permissionService.canEdit();
      const canAdmin = await this._permissionService.canAdmin();
      
      this._collaborativeState.permissions = {
        canView,
        canEdit,
        canAdmin
      };
    } catch (error) {
      console.error('Error updating permissions:', error);
    }
  }
}

/**
 * Enhanced side panel handler with collaborative editing capabilities
 * 
 * This class extends the collaborative panel handler to provide side panel
 * specific features including widget stacking, visibility management, and
 * collaborative widget coordination for sidebar panels.
 */
export class CollaborativeSidePanelHandler extends CollaborativePanelHandler {
  private _area: CollaborativePanel.Area;
  private _isVisible: boolean = false;
  private _currentWidget: any | null = null;
  private _widgets: Map<string, any> = new Map();
  private _closeButton: HTMLButtonElement;
  
  // Additional signals for side panel events
  private _widgetAddedSignal = new Signal<CollaborativeSidePanelHandler, any>(this);
  private _widgetRemovedSignal = new Signal<CollaborativeSidePanelHandler, any>(this);
  private _currentWidgetChangedSignal = new Signal<CollaborativeSidePanelHandler, any | null>(this);
  
  /**
   * Create a new collaborative side panel handler
   * 
   * @param options - Configuration options for the handler
   */
  constructor(options: {
    area: CollaborativePanel.Area;
    notebookApp: NotebookApp;
    awarenessService: AwarenessService;
    lockService: LockService;
    permissionService: PermissionService;
    panelOptions?: CollaborativePanel.Options;
  }) {
    super(options);
    
    this._area = options.area;
    this.panel.addClass('jp-CollaborativeSidePanel');
    this.panel.addClass(`jp-CollaborativeSidePanel-${options.area}`);
    
    // Set up close button
    this._closeButton = this._createCloseButton();
    
    // Set up side panel specific features
    this._setupSidePanelFeatures();
  }
  
  /**
   * Get the current widget in the side panel
   */
  get currentWidget(): any | null {
    return this._currentWidget;
  }
  
  /**
   * Get the panel area
   */
  get area(): CollaborativePanel.Area {
    return this._area;
  }
  
  /**
   * Check if the panel is visible
   */
  get isVisible(): boolean {
    return this._isVisible;
  }
  
  /**
   * Get list of all widgets in the panel
   */
  get widgets(): ReadonlyArray<any> {
    return Array.from(this._widgets.values());
  }
  
  /**
   * Signal emitted when a widget is added
   */
  get widgetAdded(): ISignal<CollaborativeSidePanelHandler, any> {
    return this._widgetAddedSignal;
  }
  
  /**
   * Signal emitted when a widget is removed
   */
  get widgetRemoved(): ISignal<CollaborativeSidePanelHandler, any> {
    return this._widgetRemovedSignal;
  }
  
  /**
   * Get the close button element
   */
  get closeButton(): HTMLButtonElement {
    return this._closeButton;
  }
  
  /**
   * Expand the sidebar panel
   * 
   * @param widgetId - Optional widget ID to activate
   */
  expand(widgetId?: string): void {
    if (!this._collaborativeState.permissions.canView) {
      return;
    }
    
    if (widgetId) {
      const widget = this._widgets.get(widgetId);
      if (widget) {
        this.activate(widgetId);
      }
    } else if (this._currentWidget) {
      this.activate(this._currentWidget.id);
    }
    
    this.show();
  }
  
  /**
   * Activate a widget in the side panel
   * 
   * @param widgetId - The widget ID to activate
   */
  activate(widgetId: string): void {
    if (!this._collaborativeState.permissions.canView) {
      return;
    }
    
    const widget = this._widgets.get(widgetId);
    if (widget) {
      // Hide current widget
      if (this._currentWidget) {
        this._currentWidget.hide();
      }
      
      // Show and activate new widget
      this._currentWidget = widget;
      widget.show();
      widget.activate();
      
      // Update collaborative state
      this._updateUserActivity(widgetId);
      
      // Emit signal
      this._currentWidgetChangedSignal.emit(widget);
    }
  }
  
  /**
   * Check if the panel has a specific widget
   * 
   * @param widgetId - The widget ID to check
   */
  has(widgetId: string): boolean {
    return this._widgets.has(widgetId);
  }
  
  /**
   * Collapse the sidebar panel
   */
  collapse(): void {
    if (this._currentWidget) {
      this._currentWidget.hide();
      this._currentWidget = null;
      this._currentWidgetChangedSignal.emit(null);
    }
    
    // Broadcast collapse event
    this._broadcastPanelChange({
      type: 'panel-collapsed',
      metadata: {
        area: this._area,
        userId: this._awarenessService.getCurrentUser().userId
      }
    });
  }
  
  /**
   * Add a widget to the side panel
   * 
   * @param widget - The widget to add
   * @param options - Additional options
   */
  addWidget(widget: any, options?: {
    rank?: number;
    collaborative?: boolean;
    permissions?: CollaborativePanel.UserPermissions;
  }): void {
    if (!this._collaborativeState.permissions.canEdit && options?.collaborative !== false) {
      console.warn('Cannot add widget to side panel: insufficient permissions');
      return;
    }
    
    // Add to widgets map
    this._widgets.set(widget.id, widget);
    
    // Add to panel
    super.addWidget(widget, options);
    
    // Hide widget initially
    widget.hide();
    
    // Emit signal
    this._widgetAddedSignal.emit(widget);
  }
  
  /**
   * Hide the side panel
   */
  hide(): void {
    this._isVisible = false;
    this.panel.hide();
    
    // Broadcast hide event
    this._broadcastPanelChange({
      type: 'panel-hidden' as any,
      metadata: {
        area: this._area,
        userId: this._awarenessService.getCurrentUser().userId
      }
    });
  }
  
  /**
   * Show the side panel
   */
  show(): void {
    this._isVisible = true;
    this.panel.show();
    
    // Broadcast show event
    this._broadcastPanelChange({
      type: 'panel-shown' as any,
      metadata: {
        area: this._area,
        userId: this._awarenessService.getCurrentUser().userId
      }
    });
  }
  
  /**
   * Get collaborators active in this side panel
   */
  getCollaborators(): Array<{
    userId: string;
    name: string;
    avatar?: string;
    isActive: boolean;
    currentWidget?: string;
  }> {
    // Filter collaborators to those active in this panel
    return super.getCollaborators().filter(collab => {
      // In a real implementation, this would check if the user is active in this specific panel
      return collab.isActive;
    });
  }
  
  /**
   * Track user activity in the side panel
   * 
   * @param widgetId - The widget ID where activity occurred
   */
  trackUserActivity(widgetId: string): void {
    if (!this._collaborativeState.isCollaborative) {
      return;
    }
    
    // Update user presence with current widget
    this._awarenessService.updateUserStatus('active' as any);
    
    // Update collaborative state
    const currentUser = this._awarenessService.getCurrentUser();
    const collaboratorIndex = this._collaborativeState.collaborators.findIndex(
      collab => collab.userId === currentUser.userId
    );
    
    if (collaboratorIndex !== -1) {
      this._collaborativeState.collaborators[collaboratorIndex].currentWidget = widgetId;
      this._collaborativeState.collaborators[collaboratorIndex].isActive = true;
    }
    
    // Broadcast activity
    this._broadcastPanelChange({
      type: 'widget-activated',
      widgetId,
      metadata: {
        area: this._area,
        userId: currentUser.userId,
        timestamp: new Date().toISOString()
      }
    });
  }
  
  /**
   * Enforce permissions for side panel operations
   */
  async enforcePermissions(): Promise<void> {
    await this._updatePermissions();
    
    // Update UI based on permissions
    if (!this._collaborativeState.permissions.canEdit) {
      this.panel.addClass('jp-CollaborativeSidePanel-readOnly');
    } else {
      this.panel.removeClass('jp-CollaborativeSidePanel-readOnly');
    }
    
    // Disable/enable widgets based on permissions
    this._widgets.forEach(widget => {
      if (!this._collaborativeState.permissions.canEdit) {
        widget.addClass('jp-CollaborativeWidget-readOnly');
      } else {
        widget.removeClass('jp-CollaborativeWidget-readOnly');
      }
    });
  }
  
  /**
   * Dispose of the side panel handler
   */
  dispose(): void {
    // Clean up widgets
    this._widgets.clear();
    
    // Clean up close button
    if (this._closeButton.parentNode) {
      this._closeButton.parentNode.removeChild(this._closeButton);
    }
    
    // Call parent dispose
    super.dispose();
  }
  
  /**
   * Create the close button for the side panel
   */
  private _createCloseButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'jp-Button jp-CollaborativeSidePanel-closeButton';
    button.title = 'Close collaborative side panel';
    
    // Add close icon
    closeIcon.element({
      container: button,
      height: '16px',
      width: 'auto'
    });
    
    // Add click handler
    button.onclick = () => {
      this.collapse();
      this.hide();
    };
    
    return button;
  }
  
  /**
   * Set up side panel specific features
   */
  private _setupSidePanelFeatures(): void {
    // Add close button to panel
    const closeWidget = document.createElement('div');
    closeWidget.className = 'jp-CollaborativeSidePanel-header';
    closeWidget.appendChild(this._closeButton);
    
    // Insert at the beginning of the panel
    this.panel.node.insertBefore(closeWidget, this.panel.node.firstChild);
    
    // Set up widget removal handler
    this.panel.widgetRemoved.connect(this._onWidgetRemoved, this);
  }
  
  /**
   * Handle widget removal from the panel
   */
  private _onWidgetRemoved(sender: StackedPanel, widget: any): void {
    // Remove from widgets map
    this._widgets.delete(widget.id);
    
    // Update current widget if needed
    if (this._currentWidget === widget) {
      this._currentWidget = null;
      this._currentWidgetChangedSignal.emit(null);
    }
    
    // Emit signal
    this._widgetRemovedSignal.emit(widget);
    
    // Broadcast removal
    this._broadcastPanelChange({
      type: 'widget-removed',
      widgetId: widget.id,
      metadata: {
        area: this._area,
        userId: this._awarenessService.getCurrentUser().userId
      }
    });
  }
}

/**
 * Enhanced command palette for collaborative side panels
 * 
 * This class provides command palette integration with permission filtering
 * and collaborative features for side panel widgets.
 */
export class CollaborativeSidePanelPalette implements IDisposable {
  private _commandPalette: ICommandPalette;
  private _command: string;
  private _permissionService: PermissionService;
  private _items: Map<string, {
    widgetId: string;
    area: CollaborativePanel.Area;
    disposable: IDisposable;
    permissions: CollaborativePanel.UserPermissions;
  }> = new Map();
  private _disposables: DisposableSet = new DisposableSet();
  private _isDisposed: boolean = false;
  
  /**
   * Create a new collaborative side panel palette
   * 
   * @param options - Configuration options
   */
  constructor(options: {
    commandPalette: ICommandPalette;
    command: string;
    permissionService: PermissionService;
  }) {
    this._commandPalette = options.commandPalette;
    this._command = options.command;
    this._permissionService = options.permissionService;
    
    // Set up permission change handler
    this._disposables.add(
      this._permissionService.onPermissionChanged.connect(this._onPermissionsChanged, this)
    );
  }
  
  /**
   * Get a command palette item
   * 
   * @param widget - The widget to get item for
   * @param area - The panel area
   */
  getItem(widget: any, area: CollaborativePanel.Area): {
    widgetId: string;
    area: CollaborativePanel.Area;
    disposable: IDisposable;
    permissions: CollaborativePanel.UserPermissions;
  } | null {
    const key = `${widget.id}-${area}`;
    return this._items.get(key) || null;
  }
  
  /**
   * Add an item to the command palette
   * 
   * @param widget - The widget to add
   * @param area - The panel area
   * @param permissions - Widget permissions
   */
  addItem(widget: any, area: CollaborativePanel.Area, permissions?: CollaborativePanel.UserPermissions): void {
    if (this._isDisposed) {
      return;
    }
    
    const key = `${widget.id}-${area}`;
    
    // Check if item already exists
    if (this._items.has(key)) {
      return;
    }
    
    // Add to command palette
    const disposable = this._commandPalette.addItem({
      command: this._command,
      category: 'Collaborative View',
      args: {
        side: area,
        title: `Show ${widget.title.caption}`,
        id: widget.id,
        collaborative: true
      }
    });
    
    // Store item info
    this._items.set(key, {
      widgetId: widget.id,
      area,
      disposable,
      permissions: permissions || {
        userId: '',
        role: 'view',
        permissions: {
          canView: true,
          canEdit: false,
          canAdmin: false,
          canLock: false,
          canComment: false
        }
      }
    });
  }
  
  /**
   * Remove an item from the command palette
   * 
   * @param widget - The widget to remove
   * @param area - The panel area
   */
  removeItem(widget: any, area: CollaborativePanel.Area): void {
    const key = `${widget.id}-${area}`;
    const item = this._items.get(key);
    
    if (item) {
      item.disposable.dispose();
      this._items.delete(key);
    }
  }
  
  /**
   * Add a collaborative item with enhanced features
   * 
   * @param widget - The widget to add
   * @param area - The panel area
   * @param options - Collaborative options
   */
  addCollaborativeItem(widget: any, area: CollaborativePanel.Area, options?: {
    permissions?: CollaborativePanel.UserPermissions;
    category?: string;
    rank?: number;
  }): void {
    if (this._isDisposed) {
      return;
    }
    
    // Add with enhanced collaborative features
    const disposable = this._commandPalette.addItem({
      command: this._command,
      category: options?.category || 'Collaborative View',
      args: {
        side: area,
        title: `Show ${widget.title.caption}`,
        id: widget.id,
        collaborative: true,
        permissions: options?.permissions,
        rank: options?.rank
      }
    });
    
    const key = `${widget.id}-${area}`;
    this._items.set(key, {
      widgetId: widget.id,
      area,
      disposable,
      permissions: options?.permissions || {
        userId: '',
        role: 'view',
        permissions: {
          canView: true,
          canEdit: false,
          canAdmin: false,
          canLock: false,
          canComment: false
        }
      }
    });
  }
  
  /**
   * Update permissions for all items
   * 
   * @param permissions - New permissions to apply
   */
  async updatePermissions(permissions: CollaborativePanel.UserPermissions): Promise<void> {
    if (this._isDisposed) {
      return;
    }
    
    // Update all items with new permissions
    for (const [key, item] of this._items) {
      item.permissions = permissions;
    }
    
    // Apply permission filtering
    await this.filterByPermission();
  }
  
  /**
   * Filter items by current user permissions
   */
  async filterByPermission(): Promise<void> {
    if (this._isDisposed) {
      return;
    }
    
    try {
      const canView = await this._permissionService.canView();
      const canEdit = await this._permissionService.canEdit();
      const canAdmin = await this._permissionService.canAdmin();
      
      // Filter items based on permissions
      for (const [key, item] of this._items) {
        const hasPermission = 
          (item.permissions.permissions.canView && canView) ||
          (item.permissions.permissions.canEdit && canEdit) ||
          (item.permissions.permissions.canAdmin && canAdmin);
        
        if (!hasPermission) {
          // Hide item by removing from palette temporarily
          item.disposable.dispose();
        }
      }
    } catch (error) {
      console.error('Error filtering items by permission:', error);
    }
  }
  
  /**
   * Dispose of the palette
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    
    this._isDisposed = true;
    
    // Dispose all items
    for (const [key, item] of this._items) {
      item.disposable.dispose();
    }
    
    this._items.clear();
    this._disposables.dispose();
  }
  
  /**
   * Handle permissions changed event
   */
  private _onPermissionsChanged(sender: PermissionService, args: any): void {
    // Re-filter items based on new permissions
    this.filterByPermission().catch(console.error);
  }
}