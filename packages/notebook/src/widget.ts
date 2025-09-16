/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Enhanced NotebookPanel widget with collaborative presence tracking and awareness features.
 * Extends the existing NotebookPanel to display user presence, cursor positions, selection highlights,
 * and integrate with the collaborative awareness system for real-time multi-user interaction visualization.
 */

import { NotebookPanel as BaseNotebookPanel } from '@jupyterlab/notebook';
import { Awareness } from 'y-protocols/awareness';
import { Signal } from '@lumino/signaling';
import * as React from 'react';

import { CollaborationAwareness } from './collab/awareness';
import { ICollaborationProvider } from './tokens';
import { NotebookModel } from './model';
import { ICollaborativeUser } from './tokens';

/**
 * Configuration interface for collaborative NotebookPanel features
 */
interface ICollaborativeNotebookPanelOptions {
  /**
   * Enable collaborative features
   */
  collaborationEnabled?: boolean;

  /**
   * Show user presence indicators
   */
  displayUserPresence?: boolean;

  /**
   * Show cursor positions from other users
   */
  showCursors?: boolean;

  /**
   * Show selection highlights from other users
   */
  showSelectionHighlights?: boolean;

  /**
   * Automatic cursor position tracking
   */
  autoTrackCursor?: boolean;

  /**
   * Update interval for presence information (milliseconds)
   */
  presenceUpdateInterval?: number;

  /**
   * Cursor overlay opacity (0-1)
   */
  cursorOpacity?: number;

  /**
   * Selection highlight opacity (0-1)
   */
  selectionOpacity?: number;

  /**
   * Enable debugging logs for collaboration
   */
  debugMode?: boolean;
}

/**
 * Cursor position information for rendering
 */
interface ICursorPosition {
  cellId: string;
  offset: number;
  user: ICollaborativeUser;
  element?: HTMLElement;
}

/**
 * Selection range information for highlighting
 */
interface ISelectionRange {
  cellId: string;
  startOffset: number;
  endOffset: number;
  user: ICollaborativeUser;
  element?: HTMLElement;
}

/**
 * Enhanced NotebookPanel with collaborative presence tracking and awareness features
 */
export class NotebookPanel extends BaseNotebookPanel {
  private _awareness: CollaborationAwareness | null = null;
  private _collaborationEnabled: boolean = false;
  private _displayUserPresence: boolean = true;
  private _showCursors: boolean = true;
  private _showSelectionHighlights: boolean = true;
  private _autoTrackCursor: boolean = true;
  private _presenceUpdateInterval: number = 1000;
  private _cursorOpacity: number = 0.8;
  private _selectionOpacity: number = 0.3;
  private _debugMode: boolean = false;
  private _isDisposed: boolean = false;

  // Overlay management
  private _cursorOverlays: Map<string, ICursorPosition> = new Map();
  private _selectionOverlays: Map<string, ISelectionRange> = new Map();
  private _overlayContainer: HTMLElement | null = null;
  private _presenceUpdateTimer: any = null;

  // Event handlers
  private _awarenessUpdateHandler = this._handleAwarenessUpdate.bind(this);
  private _userJoinHandler = this._handleUserJoin.bind(this);
  private _userLeaveHandler = this._handleUserLeave.bind(this);
  private _cursorTrackingHandler = this._handleCursorTracking.bind(this);

  // Signals
  private _onAwarenessUpdateSignal = new Signal<NotebookPanel, ICollaborativeUser[]>(this);

  /**
   * Create a new enhanced NotebookPanel with collaboration features
   */
  constructor(options: any & ICollaborativeNotebookPanelOptions = {}) {
    super(options);

    // Apply collaboration configuration
    this._collaborationEnabled = options.collaborationEnabled ?? false;
    this._displayUserPresence = options.displayUserPresence ?? true;
    this._showCursors = options.showCursors ?? true;
    this._showSelectionHighlights = options.showSelectionHighlights ?? true;
    this._autoTrackCursor = options.autoTrackCursor ?? true;
    this._presenceUpdateInterval = options.presenceUpdateInterval ?? 1000;
    this._cursorOpacity = options.cursorOpacity ?? 0.8;
    this._selectionOpacity = options.selectionOpacity ?? 0.3;
    this._debugMode = options.debugMode ?? false;

    if (this._debugMode) {
      console.log('Enhanced NotebookPanel created with collaboration features:', {
        collaborationEnabled: this._collaborationEnabled,
        displayUserPresence: this._displayUserPresence,
        showCursors: this._showCursors,
        showSelectionHighlights: this._showSelectionHighlights
      });
    }

    // Initialize collaboration features if enabled
    if (this._collaborationEnabled) {
      this._initializeCollaborationFeatures();
    }

    // Set up model change tracking
    this._setupModelTracking();
  }

  /**
   * Get the collaboration awareness instance
   */
  get awareness(): CollaborationAwareness | null {
    return this._awareness;
  }

  /**
   * Whether user presence is currently displayed
   */
  get displayUserPresence(): boolean {
    return this._displayUserPresence;
  }

  /**
   * Set whether to display user presence indicators
   */
  set displayUserPresence(value: boolean) {
    if (this._displayUserPresence !== value) {
      this._displayUserPresence = value;
      this._updatePresenceDisplay();
    }
  }

  /**
   * Whether cursors are currently shown
   */
  get showCursors(): boolean {
    return this._showCursors;
  }

  /**
   * Set whether to show cursor positions from other users
   */
  set showCursors(value: boolean) {
    if (this._showCursors !== value) {
      this._showCursors = value;
      this._updateCursorDisplay();
    }
  }

  /**
   * Whether selection highlights are currently shown
   */
  get showSelectionHighlights(): boolean {
    return this._showSelectionHighlights;
  }

  /**
   * Set whether to show selection highlights from other users
   */
  set showSelectionHighlights(value: boolean) {
    if (this._showSelectionHighlights !== value) {
      this._showSelectionHighlights = value;
      this._updateSelectionDisplay();
    }
  }

  /**
   * Signal emitted when awareness information is updated
   */
  get onAwarenessUpdate(): Signal<NotebookPanel, ICollaborativeUser[]> {
    return this._onAwarenessUpdateSignal;
  }

  /**
   * Whether this notebook panel is currently in collaborative mode
   */
  get isCollaborative(): boolean {
    return this._collaborationEnabled && this._awareness !== null;
  }

  /**
   * List of currently active users in the collaborative session
   */
  get activeUsers(): ICollaborativeUser[] {
    if (!this.isCollaborative || !this._awareness) {
      return [];
    }
    return this._awareness.activeUsers;
  }

  /**
   * Initialize collaboration features and awareness
   */
  private _initializeCollaborationFeatures(): void {
    try {
      // Initialize awareness system
      this._awareness = new CollaborationAwareness({
        presenceTimeout: 300000, // 5 minutes
        exponentialBackoff: true,
        autoAssignColors: true,
        heartbeatInterval: 30000, // 30 seconds
        persistAwareness: false
      });

      // Set up awareness event handlers
      this._awareness.onUserJoin.connect(this._userJoinHandler);
      this._awareness.onUserLeave.connect(this._userLeaveHandler);

      // Initialize overlay container
      this._createOverlayContainer();

      // Start presence update timer
      this._startPresenceUpdateTimer();

      if (this._debugMode) {
        console.log('Collaboration features initialized successfully');
      }
    } catch (error) {
      console.error('Error initializing collaboration features:', error);
      this._collaborationEnabled = false;
    }
  }

  /**
   * Set up model change tracking to connect with collaboration provider
   */
  private _setupModelTracking(): void {
    // Monitor model changes to initialize collaboration when model is available
    const checkModel = () => {
      if (this.model instanceof NotebookModel && this._collaborationEnabled) {
        this._connectToCollaborationProvider();
      }
    };

    // Check immediately and on model changes
    checkModel();
    if (this.model) {
      // Set up signal connection for model changes
      this.modelChanged.connect(() => {
        checkModel();
      });
    }
  }

  /**
   * Connect to the collaboration provider from the notebook model
   */
  private _connectToCollaborationProvider(): void {
    if (!this._awareness || !this.model || !(this.model instanceof NotebookModel)) {
      return;
    }

    try {
      const notebookModel = this.model as NotebookModel;

      // Initialize awareness with the provider
      if (notebookModel.provider) {
        this._awareness.initializeAwareness({
          websocketProvider: notebookModel.provider,
          awareness: notebookModel.provider.awareness
        } as any);

        // Set up update handlers
        notebookModel.onYjsUpdate.connect(this._awarenessUpdateHandler);

        if (this._debugMode) {
          console.log('Connected to collaboration provider');
        }
      }
    } catch (error) {
      console.error('Error connecting to collaboration provider:', error);
    }
  }

  /**
   * Create overlay container for cursor and selection indicators
   */
  private _createOverlayContainer(): void {
    if (this._overlayContainer) {
      return;
    }

    this._overlayContainer = document.createElement('div');
    this._overlayContainer.className = 'jp-NotebookPanel-collaborationOverlay';
    this._overlayContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 1000;
    `;

    // Add to notebook content area
    if (this.content.node) {
      this.content.node.style.position = 'relative';
      this.content.node.appendChild(this._overlayContainer);
    }

    if (this._debugMode) {
      console.log('Overlay container created');
    }
  }

  /**
   * Start timer for periodic presence updates
   */
  private _startPresenceUpdateTimer(): void {
    if (this._presenceUpdateTimer) {
      clearInterval(this._presenceUpdateTimer);
    }

    this._presenceUpdateTimer = setInterval(() => {
      if (this._collaborationEnabled && this._awareness && !this._isDisposed) {
        this._updatePresenceInformation();
      }
    }, this._presenceUpdateInterval);
  }

  /**
   * Update presence information from awareness system
   */
  private _updatePresenceInformation(): void {
    if (!this._awareness) {
      return;
    }

    try {
      // Update cursor tracking
      if (this._autoTrackCursor && this._showCursors) {
        this._trackLocalCursor();
      }

      // Update selection tracking
      if (this._showSelectionHighlights) {
        this._trackLocalSelection();
      }

      // Refresh overlay displays
      this._refreshOverlays();

      // Emit awareness update signal
      this._onAwarenessUpdateSignal.emit(this.activeUsers);

    } catch (error) {
      if (this._debugMode) {
        console.error('Error updating presence information:', error);
      }
    }
  }

  /**
   * Track local cursor position for broadcasting to other users
   */
  private _trackLocalCursor(): void {
    if (!this._awareness) {
      return;
    }

    try {
      // Get active cell and cursor position
      const activeCell = this.content.activeCell;
      if (!activeCell || !activeCell.model) {
        return;
      }

      const cellId = activeCell.model.metadata.get('id') as string || activeCell.model.id;

      // Get cursor position from editor
      let cursorOffset = 0;
      if (activeCell.editor) {
        const cursor = activeCell.editor.getCursorPosition();
        if (cursor) {
          cursorOffset = cursor.column;
        }
      }

      // Update awareness with current cursor position
      this._awareness.updateCursorPosition(cellId, cursorOffset);

    } catch (error) {
      if (this._debugMode) {
        console.error('Error tracking local cursor:', error);
      }
    }
  }

  /**
   * Track local selection for broadcasting to other users
   */
  private _trackLocalSelection(): void {
    if (!this._awareness) {
      return;
    }

    try {
      // Get selected cells
      const selectedCells: string[] = [];

      if (this.content.widgets) {
        this.content.widgets.forEach((cell, index) => {
          if (this.content.isSelected(cell)) {
            const cellId = cell.model.metadata.get('id') as string || cell.model.id;
            selectedCells.push(cellId);
          }
        });
      }

      // Update awareness with selected cells
      this._awareness.updateSelectedCells(selectedCells);

    } catch (error) {
      if (this._debugMode) {
        console.error('Error tracking local selection:', error);
      }
    }
  }

  /**
   * Refresh all overlay displays
   */
  private _refreshOverlays(): void {
    if (this._displayUserPresence) {
      this._updateCursorOverlays();
      this._updateSelectionOverlays();
    }
  }

  /**
   * Update cursor overlays for remote users
   */
  private _updateCursorOverlays(): void {
    if (!this._showCursors || !this._awareness || !this._overlayContainer) {
      return;
    }

    // Clear existing cursor overlays
    this._clearCursorOverlays();

    // Get active users and render their cursors
    const activeUsers = this._awareness.activeUsers;

    for (const user of activeUsers) {
      const cursorPos = this._awareness.getCursorPosition(user.userId);
      if (cursorPos && cursorPos.cellId && cursorPos.offset >= 0) {
        this._renderUserCursor(user, cursorPos);
      }
    }
  }

  /**
   * Update selection overlays for remote users
   */
  private _updateSelectionOverlays(): void {
    if (!this._showSelectionHighlights || !this._awareness || !this._overlayContainer) {
      return;
    }

    // Clear existing selection overlays
    this._clearSelectionOverlays();

    // Get active users and render their selections
    const activeUsers = this._awareness.activeUsers;

    for (const user of activeUsers) {
      const selectedCells = this._awareness.getSelectedCells(user.userId);
      if (selectedCells && selectedCells.length > 0) {
        this._renderUserSelection(user, selectedCells);
      }
    }
  }

  /**
   * Render cursor indicator for a remote user
   */
  private _renderUserCursor(user: ICollaborativeUser, cursorPos: { cellId: string; offset: number }): void {
    try {
      // Find cell element
      const cellElement = this._findCellElementById(cursorPos.cellId);
      if (!cellElement) {
        return;
      }

      // Create cursor indicator
      const cursorElement = document.createElement('div');
      cursorElement.className = 'jp-NotebookPanel-collaborationCursor';
      cursorElement.style.cssText = `
        position: absolute;
        width: 2px;
        height: 20px;
        background-color: ${user.color};
        opacity: ${this._cursorOpacity};
        border-radius: 1px;
        pointer-events: none;
        z-index: 1001;
        box-shadow: 0 0 3px rgba(0,0,0,0.3);
      `;

      // Add user label
      const labelElement = document.createElement('div');
      labelElement.className = 'jp-NotebookPanel-collaborationCursorLabel';
      labelElement.textContent = user.displayName;
      labelElement.style.cssText = `
        position: absolute;
        top: -25px;
        left: -5px;
        padding: 2px 6px;
        background-color: ${user.color};
        color: white;
        font-size: 11px;
        font-weight: 500;
        border-radius: 3px;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0.9;
      `;

      cursorElement.appendChild(labelElement);

      // Position cursor within cell
      this._positionCursorInCell(cursorElement, cellElement, cursorPos.offset);

      // Add to overlay container
      this._overlayContainer!.appendChild(cursorElement);

      // Store cursor information
      this._cursorOverlays.set(user.userId, {
        cellId: cursorPos.cellId,
        offset: cursorPos.offset,
        user,
        element: cursorElement
      });

    } catch (error) {
      if (this._debugMode) {
        console.error('Error rendering user cursor:', error);
      }
    }
  }

  /**
   * Render selection highlight for a remote user
   */
  private _renderUserSelection(user: ICollaborativeUser, selectedCells: string[]): void {
    try {
      for (const cellId of selectedCells) {
        const cellElement = this._findCellElementById(cellId);
        if (!cellElement) {
          continue;
        }

        // Create selection highlight
        const selectionElement = document.createElement('div');
        selectionElement.className = 'jp-NotebookPanel-collaborationSelection';
        selectionElement.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: ${user.color};
          opacity: ${this._selectionOpacity};
          border: 2px solid ${user.color};
          border-radius: 4px;
          pointer-events: none;
          z-index: 999;
        `;

        // Add user label
        const labelElement = document.createElement('div');
        labelElement.className = 'jp-NotebookPanel-collaborationSelectionLabel';
        labelElement.textContent = `${user.displayName} selected`;
        labelElement.style.cssText = `
          position: absolute;
          top: -25px;
          right: 5px;
          padding: 2px 6px;
          background-color: ${user.color};
          color: white;
          font-size: 11px;
          font-weight: 500;
          border-radius: 3px;
          white-space: nowrap;
          pointer-events: none;
          opacity: 0.9;
        `;

        selectionElement.appendChild(labelElement);

        // Position selection within cell
        this._positionSelectionInCell(selectionElement, cellElement);

        // Add to overlay container
        this._overlayContainer!.appendChild(selectionElement);

        // Store selection information
        this._selectionOverlays.set(`${user.userId}-${cellId}`, {
          cellId,
          startOffset: 0,
          endOffset: -1, // Full cell selection
          user,
          element: selectionElement
        });
      }
    } catch (error) {
      if (this._debugMode) {
        console.error('Error rendering user selection:', error);
      }
    }
  }

  /**
   * Find cell element by ID
   */
  private _findCellElementById(cellId: string): HTMLElement | null {
    if (!this.content.widgets) {
      return null;
    }

    for (const cell of this.content.widgets) {
      const modelId = cell.model.metadata.get('id') as string || cell.model.id;
      if (modelId === cellId) {
        return cell.node as HTMLElement;
      }
    }

    return null;
  }

  /**
   * Position cursor element within cell
   */
  private _positionCursorInCell(cursorElement: HTMLElement, cellElement: HTMLElement, offset: number): void {
    try {
      const cellRect = cellElement.getBoundingClientRect();
      const containerRect = this._overlayContainer!.getBoundingClientRect();

      // Calculate relative position
      const left = cellRect.left - containerRect.left + (offset * 8); // Approximate character width
      const top = cellRect.top - containerRect.top + 10; // Offset from cell top

      cursorElement.style.left = `${left}px`;
      cursorElement.style.top = `${top}px`;

    } catch (error) {
      if (this._debugMode) {
        console.error('Error positioning cursor:', error);
      }
    }
  }

  /**
   * Position selection element within cell
   */
  private _positionSelectionInCell(selectionElement: HTMLElement, cellElement: HTMLElement): void {
    try {
      const cellRect = cellElement.getBoundingClientRect();
      const containerRect = this._overlayContainer!.getBoundingClientRect();

      // Calculate relative position
      const left = cellRect.left - containerRect.left;
      const top = cellRect.top - containerRect.top;
      const width = cellRect.width;
      const height = cellRect.height;

      selectionElement.style.left = `${left}px`;
      selectionElement.style.top = `${top}px`;
      selectionElement.style.width = `${width}px`;
      selectionElement.style.height = `${height}px`;

    } catch (error) {
      if (this._debugMode) {
        console.error('Error positioning selection:', error);
      }
    }
  }

  /**
   * Clear all cursor overlays
   */
  private _clearCursorOverlays(): void {
    this._cursorOverlays.forEach((cursorInfo) => {
      if (cursorInfo.element && cursorInfo.element.parentNode) {
        cursorInfo.element.parentNode.removeChild(cursorInfo.element);
      }
    });
    this._cursorOverlays.clear();
  }

  /**
   * Clear all selection overlays
   */
  private _clearSelectionOverlays(): void {
    this._selectionOverlays.forEach((selectionInfo) => {
      if (selectionInfo.element && selectionInfo.element.parentNode) {
        selectionInfo.element.parentNode.removeChild(selectionInfo.element);
      }
    });
    this._selectionOverlays.clear();
  }

  /**
   * Update presence display based on current settings
   */
  private _updatePresenceDisplay(): void {
    if (this._displayUserPresence) {
      this._refreshOverlays();
    } else {
      this._clearCursorOverlays();
      this._clearSelectionOverlays();
    }
  }

  /**
   * Update cursor display based on current settings
   */
  private _updateCursorDisplay(): void {
    if (this._showCursors && this._displayUserPresence) {
      this._updateCursorOverlays();
    } else {
      this._clearCursorOverlays();
    }
  }

  /**
   * Update selection display based on current settings
   */
  private _updateSelectionDisplay(): void {
    if (this._showSelectionHighlights && this._displayUserPresence) {
      this._updateSelectionOverlays();
    } else {
      this._clearSelectionOverlays();
    }
  }

  /**
   * Handle awareness updates from the collaboration system
   */
  private _handleAwarenessUpdate(sender: any, data: { origin: any; update: Uint8Array }): void {
    if (this._isDisposed) {
      return;
    }

    try {
      // Process awareness update
      this._updatePresenceInformation();

      if (this._debugMode) {
        console.log('Awareness update processed:', data);
      }
    } catch (error) {
      if (this._debugMode) {
        console.error('Error handling awareness update:', error);
      }
    }
  }

  /**
   * Handle user joining the collaborative session
   */
  private _handleUserJoin(sender: CollaborationAwareness, user: ICollaborativeUser): void {
    if (this._isDisposed) {
      return;
    }

    try {
      if (this._debugMode) {
        console.log('User joined collaborative session:', user.displayName);
      }

      // Refresh displays to show new user
      this._refreshOverlays();

      // Emit awareness update
      this._onAwarenessUpdateSignal.emit(this.activeUsers);
    } catch (error) {
      if (this._debugMode) {
        console.error('Error handling user join:', error);
      }
    }
  }

  /**
   * Handle user leaving the collaborative session
   */
  private _handleUserLeave(sender: CollaborationAwareness, user: ICollaborativeUser): void {
    if (this._isDisposed) {
      return;
    }

    try {
      if (this._debugMode) {
        console.log('User left collaborative session:', user.displayName);
      }

      // Remove user's overlays
      const cursorOverlay = this._cursorOverlays.get(user.userId);
      if (cursorOverlay && cursorOverlay.element && cursorOverlay.element.parentNode) {
        cursorOverlay.element.parentNode.removeChild(cursorOverlay.element);
        this._cursorOverlays.delete(user.userId);
      }

      // Remove user's selection overlays
      const keysToRemove: string[] = [];
      this._selectionOverlays.forEach((selectionInfo, key) => {
        if (selectionInfo.user.userId === user.userId) {
          if (selectionInfo.element && selectionInfo.element.parentNode) {
            selectionInfo.element.parentNode.removeChild(selectionInfo.element);
          }
          keysToRemove.push(key);
        }
      });

      keysToRemove.forEach(key => {
        this._selectionOverlays.delete(key);
      });

      // Emit awareness update
      this._onAwarenessUpdateSignal.emit(this.activeUsers);
    } catch (error) {
      if (this._debugMode) {
        console.error('Error handling user leave:', error);
      }
    }
  }

  /**
   * Handle cursor tracking events
   */
  private _handleCursorTracking(event: Event): void {
    if (this._isDisposed || !this._autoTrackCursor || !this._awareness) {
      return;
    }

    // Defer cursor tracking to avoid excessive updates
    setTimeout(() => {
      this._trackLocalCursor();
    }, 100);
  }

  /**
   * Dispose of the enhanced notebook panel and clean up resources
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;

    // Clean up timers
    if (this._presenceUpdateTimer) {
      clearInterval(this._presenceUpdateTimer);
      this._presenceUpdateTimer = null;
    }

    // Clean up overlays
    this._clearCursorOverlays();
    this._clearSelectionOverlays();

    // Remove overlay container
    if (this._overlayContainer && this._overlayContainer.parentNode) {
      this._overlayContainer.parentNode.removeChild(this._overlayContainer);
      this._overlayContainer = null;
    }

    // Clean up awareness system
    if (this._awareness) {
      this._awareness.onUserJoin.disconnect(this._userJoinHandler);
      this._awareness.onUserLeave.disconnect(this._userLeaveHandler);
      this._awareness.cleanup();
      this._awareness = null;
    }

    // Disconnect model signals
    if (this.model instanceof NotebookModel) {
      this.model.onYjsUpdate.disconnect(this._awarenessUpdateHandler);
    }

    // Clean up collections
    this._cursorOverlays.clear();
    this._selectionOverlays.clear();

    if (this._debugMode) {
      console.log('Enhanced NotebookPanel disposed');
    }

    // Call parent dispose
    super.dispose();
  }
}
