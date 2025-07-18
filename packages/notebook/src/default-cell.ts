/**
 * @fileoverview Enhanced default cell component for collaborative notebook editing
 * 
 * This module provides comprehensive collaborative editing capabilities for Jupyter
 * Notebook cells, including cell-level locking indicators, user presence visualization,
 * collaborative cursors, and comment system integration for both code and markdown cells.
 * 
 * Key features:
 * - Cell-level locking mechanism with visual indicators
 * - Real-time user presence awareness and cursor tracking
 * - Collaborative comment system with threading
 * - Enhanced UI components for collaborative status
 * - Support for all cell types (code, markdown, raw)
 * - Integration with Yjs CRDT framework for real-time updates
 * 
 * The system ensures seamless collaborative editing while maintaining the single-user
 * experience when collaboration is disabled.
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Cell } from '@jupyterlab/notebook';
import { Widget } from '@lumino/widgets';
import { Signal } from '@lumino/signaling';
import { Doc } from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { reactIcon } from '@jupyterlab/ui-components';
import { ICellModel } from '@jupyterlab/cells';
import { IDisposable } from '@lumino/disposable';
import { IEditor } from '@jupyterlab/codeeditor';

import { CellOperations } from './celloperations';
import { LockService } from './collab/locks';
import { AwarenessService } from './collab/awareness';
import { CommentService } from './collab/comments';
import { YjsNotebookProvider } from './model';
import { IAwarenessService } from './tokens';

/**
 * Interface for collaborative cell options and configuration
 */
export interface ICollaborativeCellOptions {
  /** Cell model instance */
  model: ICellModel;
  /** YJS document provider for collaboration */
  yjsProvider: YjsNotebookProvider;
  /** Awareness service for user presence */
  awarenessService: AwarenessService;
  /** Lock service for cell locking */
  lockService: LockService;
  /** Comment service for cell comments */
  commentService: CommentService;
  /** Cell operations handler */
  cellOperations: CellOperations;
  /** Whether collaborative features are enabled */
  collaborativeEnabled?: boolean;
  /** Whether to show presence indicators */
  showPresence?: boolean;
  /** Whether to enable cell locking */
  enableLocking?: boolean;
  /** Whether to enable comment system */
  enableComments?: boolean;
}

/**
 * Interface for lock state information
 */
export interface ILockState {
  /** Whether the cell is currently locked */
  isLocked: boolean;
  /** User ID of the lock owner */
  lockOwner?: string;
  /** Display name of the lock owner */
  lockOwnerName?: string;
  /** Timestamp when the lock expires */
  lockTimeout?: Date;
}

/**
 * Interface for user presence information
 */
export interface IPresenceState {
  /** List of active users in the cell */
  activeUsers: Array<{
    userId: string;
    name: string;
    avatar?: string;
    cursor?: { line: number; column: number };
    selection?: { start: number; end: number };
    isActive: boolean;
  }>;
  /** Cursor positions for all users */
  cursorPositions: Map<string, { line: number; column: number }>;
  /** Selection states for all users */
  selectionStates: Map<string, { start: number; end: number }>;
}

/**
 * Interface for comment state information
 */
export interface ICommentState {
  /** List of comments for the cell */
  comments: Array<{
    id: string;
    author: { id: string; name: string; avatar?: string };
    content: string;
    timestamp: Date;
    resolved: boolean;
  }>;
  /** Total number of comments */
  commentCount: number;
  /** Number of unread comments */
  unreadCount: number;
  /** Whether comments are currently visible */
  commentsVisible: boolean;
}

/**
 * Cell lock indicator component that displays lock status visually
 */
export class CellLockIndicator extends Widget {
  private _lockState: ILockState = { isLocked: false };
  private _lockService: LockService;
  private _cellId: string;
  private _lockIcon: HTMLElement | null = null;
  private _lockTooltip: HTMLElement | null = null;
  private _disposed: boolean = false;

  /**
   * Creates a new cell lock indicator
   * 
   * @param cellId - The ID of the cell to monitor
   * @param lockService - The lock service instance
   */
  constructor(cellId: string, lockService: LockService) {
    super();
    this._cellId = cellId;
    this._lockService = lockService;
    
    this.addClass('jp-CellLockIndicator');
    this._setupLockIndicator();
    this._setupEventListeners();
  }

  /**
   * Whether the cell is currently locked
   */
  get isLocked(): boolean {
    return this._lockState.isLocked;
  }

  /**
   * The current lock owner information
   */
  get lockOwner(): string | undefined {
    return this._lockState.lockOwnerName;
  }

  /**
   * The lock timeout timestamp
   */
  get lockTimeout(): Date | undefined {
    return this._lockState.lockTimeout;
  }

  /**
   * Show the lock indicator with current state
   */
  show(): void {
    this.setHidden(false);
    this._updateLockDisplay();
  }

  /**
   * Hide the lock indicator
   */
  hide(): void {
    this.setHidden(true);
  }

  /**
   * Update the lock status display
   * 
   * @param lockState - The new lock state
   */
  updateStatus(lockState: ILockState): void {
    this._lockState = { ...lockState };
    this._updateLockDisplay();
  }

  /**
   * Dispose of the lock indicator
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    super.dispose();
  }

  /**
   * Set up the lock indicator UI elements
   */
  private _setupLockIndicator(): void {
    // Create lock icon element
    this._lockIcon = document.createElement('div');
    this._lockIcon.className = 'jp-CellLockIcon';
    this.node.appendChild(this._lockIcon);

    // Create tooltip element
    this._lockTooltip = document.createElement('div');
    this._lockTooltip.className = 'jp-CellLockTooltip';
    this._lockTooltip.style.display = 'none';
    this.node.appendChild(this._lockTooltip);

    // Add hover event for tooltip
    this.node.addEventListener('mouseenter', () => {
      if (this._lockTooltip && this._lockState.isLocked) {
        this._lockTooltip.style.display = 'block';
      }
    });

    this.node.addEventListener('mouseleave', () => {
      if (this._lockTooltip) {
        this._lockTooltip.style.display = 'none';
      }
    });
  }

  /**
   * Set up event listeners for lock changes
   */
  private _setupEventListeners(): void {
    // Subscribe to lock changes for this cell
    this._lockService.subscribeToLockChanges(this._cellId, (isLocked, owner) => {
      this.updateStatus({
        isLocked,
        lockOwner: owner?.userId,
        lockOwnerName: owner?.name,
        lockTimeout: isLocked ? new Date(Date.now() + this._lockService.getLockTimeout()) : undefined
      });
    });
  }

  /**
   * Update the visual display of the lock indicator
   */
  private _updateLockDisplay(): void {
    if (!this._lockIcon || !this._lockTooltip) {
      return;
    }

    if (this._lockState.isLocked) {
      // Show locked state
      this._lockIcon.innerHTML = '🔒';
      this._lockIcon.style.color = '#ff6b6b';
      this._lockTooltip.textContent = `Locked by ${this._lockState.lockOwnerName || 'another user'}`;
      this.addClass('jp-CellLockIndicator-locked');
    } else {
      // Show unlocked state
      this._lockIcon.innerHTML = '🔓';
      this._lockIcon.style.color = '#4ecdc4';
      this._lockTooltip.textContent = 'Available for editing';
      this.removeClass('jp-CellLockIndicator-locked');
    }
  }
}

/**
 * Cell presence indicator component that displays user presence and cursors
 */
export class CellPresenceIndicator extends Widget {
  private _presenceState: IPresenceState = {
    activeUsers: [],
    cursorPositions: new Map(),
    selectionStates: new Map()
  };
  private _awarenessService: AwarenessService;
  private _cellId: string;
  private _presenceContainer: HTMLElement | null = null;
  private _cursorOverlay: HTMLElement | null = null;
  private _disposed: boolean = false;

  /**
   * Creates a new cell presence indicator
   * 
   * @param cellId - The ID of the cell to monitor
   * @param awarenessService - The awareness service instance
   */
  constructor(cellId: string, awarenessService: AwarenessService) {
    super();
    this._cellId = cellId;
    this._awarenessService = awarenessService;
    
    this.addClass('jp-CellPresenceIndicator');
    this._setupPresenceIndicator();
    this._setupEventListeners();
  }

  /**
   * Get the currently active users in the cell
   */
  get activeUsers(): Array<{
    userId: string;
    name: string;
    avatar?: string;
    cursor?: { line: number; column: number };
    selection?: { start: number; end: number };
    isActive: boolean;
  }> {
    return this._presenceState.activeUsers;
  }

  /**
   * Get cursor positions for all users
   */
  get cursorPositions(): Map<string, { line: number; column: number }> {
    return this._presenceState.cursorPositions;
  }

  /**
   * Get selection states for all users
   */
  get selectionStates(): Map<string, { start: number; end: number }> {
    return this._presenceState.selectionStates;
  }

  /**
   * Update the presence information for all users
   * 
   * @param presenceState - The new presence state
   */
  updatePresence(presenceState: IPresenceState): void {
    this._presenceState = { ...presenceState };
    this._updatePresenceDisplay();
  }

  /**
   * Show cursor for a specific user
   * 
   * @param userId - The user ID
   * @param position - The cursor position
   */
  showUserCursor(userId: string, position: { line: number; column: number }): void {
    this._presenceState.cursorPositions.set(userId, position);
    this._updateCursorDisplay();
  }

  /**
   * Hide cursor for a specific user
   * 
   * @param userId - The user ID
   */
  hideUserCursor(userId: string): void {
    this._presenceState.cursorPositions.delete(userId);
    this._updateCursorDisplay();
  }

  /**
   * Highlight selection for a specific user
   * 
   * @param userId - The user ID
   * @param selection - The selection range
   */
  highlightSelection(userId: string, selection: { start: number; end: number }): void {
    this._presenceState.selectionStates.set(userId, selection);
    this._updateSelectionDisplay();
  }

  /**
   * Dispose of the presence indicator
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    super.dispose();
  }

  /**
   * Set up the presence indicator UI elements
   */
  private _setupPresenceIndicator(): void {
    // Create presence container
    this._presenceContainer = document.createElement('div');
    this._presenceContainer.className = 'jp-CellPresenceContainer';
    this.node.appendChild(this._presenceContainer);

    // Create cursor overlay
    this._cursorOverlay = document.createElement('div');
    this._cursorOverlay.className = 'jp-CellCursorOverlay';
    this.node.appendChild(this._cursorOverlay);
  }

  /**
   * Set up event listeners for presence changes
   */
  private _setupEventListeners(): void {
    // Listen for user join/leave events
    this._awarenessService.onUserJoin.connect(this._onUserJoin, this);
    this._awarenessService.onUserLeave.connect(this._onUserLeave, this);
    
    // Listen for user updates
    this._awarenessService.onUserUpdate.connect(this._onUserUpdate, this);
  }

  /**
   * Handle user join event
   */
  private _onUserJoin(sender: AwarenessService, args: { userId: string; name: string; avatar?: string }): void {
    this._refreshPresenceState();
  }

  /**
   * Handle user leave event
   */
  private _onUserLeave(sender: AwarenessService, args: { userId: string }): void {
    this._presenceState.cursorPositions.delete(args.userId);
    this._presenceState.selectionStates.delete(args.userId);
    this._refreshPresenceState();
  }

  /**
   * Handle user update event
   */
  private _onUserUpdate(sender: AwarenessService, args: any): void {
    this._refreshPresenceState();
  }

  /**
   * Refresh the presence state from the awareness service
   */
  private _refreshPresenceState(): void {
    const users = this._awarenessService.getUsers();
    this._presenceState.activeUsers = users.filter(user => 
      user.cursor?.cellId === this._cellId || user.selection?.cellId === this._cellId
    );
    this._updatePresenceDisplay();
  }

  /**
   * Update the visual display of user presence
   */
  private _updatePresenceDisplay(): void {
    if (!this._presenceContainer) {
      return;
    }

    // Clear existing display
    this._presenceContainer.innerHTML = '';

    // Add user avatars
    this._presenceState.activeUsers.forEach(user => {
      const userElement = document.createElement('div');
      userElement.className = 'jp-CellPresenceUser';
      userElement.title = user.name;
      
      if (user.avatar) {
        const img = document.createElement('img');
        img.src = user.avatar;
        img.alt = user.name;
        userElement.appendChild(img);
      } else {
        userElement.textContent = user.name.charAt(0).toUpperCase();
      }
      
      this._presenceContainer.appendChild(userElement);
    });
  }

  /**
   * Update cursor display for all users
   */
  private _updateCursorDisplay(): void {
    if (!this._cursorOverlay) {
      return;
    }

    // Clear existing cursors
    this._cursorOverlay.innerHTML = '';

    // Add cursor elements for each user
    this._presenceState.cursorPositions.forEach((position, userId) => {
      const user = this._presenceState.activeUsers.find(u => u.userId === userId);
      if (user) {
        const cursorElement = document.createElement('div');
        cursorElement.className = 'jp-CellUserCursor';
        cursorElement.style.top = `${position.line * 20}px`;
        cursorElement.style.left = `${position.column * 8}px`;
        cursorElement.title = `${user.name}'s cursor`;
        this._cursorOverlay.appendChild(cursorElement);
      }
    });
  }

  /**
   * Update selection display for all users
   */
  private _updateSelectionDisplay(): void {
    // Selection highlighting would be integrated with the editor
    // This is a placeholder for the selection display logic
  }
}

/**
 * Cell comment widget that manages comments for a cell
 */
export class CellCommentWidget extends Widget {
  private _commentState: ICommentState = {
    comments: [],
    commentCount: 0,
    unreadCount: 0,
    commentsVisible: false
  };
  private _commentService: CommentService;
  private _cellId: string;
  private _commentContainer: HTMLElement | null = null;
  private _commentButton: HTMLElement | null = null;
  private _disposed: boolean = false;

  /**
   * Creates a new cell comment widget
   * 
   * @param cellId - The ID of the cell
   * @param commentService - The comment service instance
   */
  constructor(cellId: string, commentService: CommentService) {
    super();
    this._cellId = cellId;
    this._commentService = commentService;
    
    this.addClass('jp-CellCommentWidget');
    this._setupCommentWidget();
    this._setupEventListeners();
  }

  /**
   * Get the current comments for the cell
   */
  get comments(): Array<{
    id: string;
    author: { id: string; name: string; avatar?: string };
    content: string;
    timestamp: Date;
    resolved: boolean;
  }> {
    return this._commentState.comments;
  }

  /**
   * Get the total number of comments
   */
  get commentCount(): number {
    return this._commentState.commentCount;
  }

  /**
   * Get the number of unread comments
   */
  get unreadCount(): number {
    return this._commentState.unreadCount;
  }

  /**
   * Add a new comment to the cell
   * 
   * @param content - The comment content
   * @param parentId - Optional parent comment ID for replies
   */
  async addComment(content: string, parentId?: string): Promise<void> {
    try {
      await this._commentService.addComment(this._cellId, content, parentId);
      this._refreshComments();
    } catch (error) {
      console.error('Error adding comment:', error);
    }
  }

  /**
   * Reply to an existing comment
   * 
   * @param commentId - The comment ID to reply to
   * @param content - The reply content
   */
  async replyToComment(commentId: string, content: string): Promise<void> {
    try {
      await this._commentService.addComment(this._cellId, content, commentId);
      this._refreshComments();
    } catch (error) {
      console.error('Error replying to comment:', error);
    }
  }

  /**
   * Resolve a comment
   * 
   * @param commentId - The comment ID to resolve
   */
  async resolveComment(commentId: string): Promise<void> {
    try {
      await this._commentService.resolveComment(commentId);
      this._refreshComments();
    } catch (error) {
      console.error('Error resolving comment:', error);
    }
  }

  /**
   * Show the comments panel
   */
  showComments(): void {
    this._commentState.commentsVisible = true;
    this._updateCommentDisplay();
  }

  /**
   * Hide the comments panel
   */
  hideComments(): void {
    this._commentState.commentsVisible = false;
    this._updateCommentDisplay();
  }

  /**
   * Update the comment count display
   * 
   * @param count - The new comment count
   * @param unreadCount - The new unread count
   */
  updateCommentCount(count: number, unreadCount: number): void {
    this._commentState.commentCount = count;
    this._commentState.unreadCount = unreadCount;
    this._updateCommentButton();
  }

  /**
   * Dispose of the comment widget
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    super.dispose();
  }

  /**
   * Set up the comment widget UI elements
   */
  private _setupCommentWidget(): void {
    // Create comment button
    this._commentButton = document.createElement('button');
    this._commentButton.className = 'jp-CellCommentButton';
    this._commentButton.innerHTML = '💬';
    this._commentButton.title = 'Comments';
    this._commentButton.onclick = () => this._toggleComments();
    this.node.appendChild(this._commentButton);

    // Create comment container
    this._commentContainer = document.createElement('div');
    this._commentContainer.className = 'jp-CellCommentContainer';
    this._commentContainer.style.display = 'none';
    this.node.appendChild(this._commentContainer);
  }

  /**
   * Set up event listeners for comment changes
   */
  private _setupEventListeners(): void {
    // Listen for new comments
    this._commentService.onNewComment.connect(this._onNewComment, this);
    
    // Listen for comment resolution
    this._commentService.onCommentResolved.connect(this._onCommentResolved, this);
  }

  /**
   * Handle new comment event
   */
  private _onNewComment(sender: CommentService, comment: any): void {
    if (comment.cellId === this._cellId) {
      this._refreshComments();
    }
  }

  /**
   * Handle comment resolved event
   */
  private _onCommentResolved(sender: CommentService, args: { commentId: string; resolvedBy: string }): void {
    this._refreshComments();
  }

  /**
   * Toggle the comments panel visibility
   */
  private _toggleComments(): void {
    if (this._commentState.commentsVisible) {
      this.hideComments();
    } else {
      this.showComments();
    }
  }

  /**
   * Refresh comments from the service
   */
  private async _refreshComments(): Promise<void> {
    try {
      const comments = await this._commentService.getCommentsByCell(this._cellId);
      this._commentState.comments = comments;
      this._commentState.commentCount = comments.length;
      this._commentState.unreadCount = comments.filter(c => !c.resolved).length;
      this._updateCommentDisplay();
    } catch (error) {
      console.error('Error refreshing comments:', error);
    }
  }

  /**
   * Update the comment display
   */
  private _updateCommentDisplay(): void {
    if (!this._commentContainer) {
      return;
    }

    if (this._commentState.commentsVisible) {
      this._commentContainer.style.display = 'block';
      this._renderComments();
    } else {
      this._commentContainer.style.display = 'none';
    }

    this._updateCommentButton();
  }

  /**
   * Update the comment button display
   */
  private _updateCommentButton(): void {
    if (!this._commentButton) {
      return;
    }

    if (this._commentState.commentCount > 0) {
      this._commentButton.textContent = `💬 ${this._commentState.commentCount}`;
      this._commentButton.classList.add('jp-CellCommentButton-hasComments');
    } else {
      this._commentButton.textContent = '💬';
      this._commentButton.classList.remove('jp-CellCommentButton-hasComments');
    }

    if (this._commentState.unreadCount > 0) {
      this._commentButton.classList.add('jp-CellCommentButton-hasUnread');
    } else {
      this._commentButton.classList.remove('jp-CellCommentButton-hasUnread');
    }
  }

  /**
   * Render the comments list
   */
  private _renderComments(): void {
    if (!this._commentContainer) {
      return;
    }

    this._commentContainer.innerHTML = '';
    
    this._commentState.comments.forEach(comment => {
      const commentElement = document.createElement('div');
      commentElement.className = 'jp-CellComment';
      
      const authorElement = document.createElement('div');
      authorElement.className = 'jp-CellCommentAuthor';
      authorElement.textContent = comment.author.name;
      
      const contentElement = document.createElement('div');
      contentElement.className = 'jp-CellCommentContent';
      contentElement.textContent = comment.content;
      
      const timestampElement = document.createElement('div');
      timestampElement.className = 'jp-CellCommentTimestamp';
      timestampElement.textContent = comment.timestamp.toLocaleString();
      
      commentElement.appendChild(authorElement);
      commentElement.appendChild(contentElement);
      commentElement.appendChild(timestampElement);
      
      this._commentContainer.appendChild(commentElement);
    });
  }
}

/**
 * Enhanced collaborative code cell with collaborative features
 */
export class CollaborativeCodeCell extends Cell {
  private _collaborativeOptions: ICollaborativeCellOptions;
  private _lockIndicator: CellLockIndicator;
  private _presenceIndicator: CellPresenceIndicator;
  private _commentWidget: CellCommentWidget;
  private _disposed: boolean = false;

  /**
   * Creates a new collaborative code cell
   * 
   * @param options - The collaborative cell options
   */
  constructor(options: ICollaborativeCellOptions) {
    super(options);
    this._collaborativeOptions = options;
    
    // Initialize collaborative components
    this._lockIndicator = new CellLockIndicator(
      options.model.id,
      options.lockService
    );
    this._presenceIndicator = new CellPresenceIndicator(
      options.model.id,
      options.awarenessService
    );
    this._commentWidget = new CellCommentWidget(
      options.model.id,
      options.commentService
    );
    
    this._setupCollaborativeFeatures();
  }

  /**
   * Get the lock indicator component
   */
  get lockIndicator(): CellLockIndicator {
    return this._lockIndicator;
  }

  /**
   * Get the presence indicator component
   */
  get presenceIndicator(): CellPresenceIndicator {
    return this._presenceIndicator;
  }

  /**
   * Get the comment widget component
   */
  get commentWidget(): CellCommentWidget {
    return this._commentWidget;
  }

  /**
   * Toggle the lock state of the cell
   */
  async toggleLock(): Promise<void> {
    try {
      const isLocked = await this._collaborativeOptions.lockService.isLocked(this.model.id);
      if (isLocked) {
        await this._collaborativeOptions.cellOperations.unlockCell(this.model.id);
      } else {
        await this._collaborativeOptions.cellOperations.lockCell(this.model.id);
      }
    } catch (error) {
      console.error('Error toggling cell lock:', error);
    }
  }

  /**
   * Show comments for the cell
   */
  showComments(): void {
    this._commentWidget.showComments();
  }

  /**
   * Hide comments for the cell
   */
  hideComments(): void {
    this._commentWidget.hideComments();
  }

  /**
   * Update presence information for the cell
   * 
   * @param presenceState - The new presence state
   */
  updatePresence(presenceState: IPresenceState): void {
    this._presenceIndicator.updatePresence(presenceState);
  }

  /**
   * Dispose of the collaborative code cell
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    
    this._lockIndicator.dispose();
    this._presenceIndicator.dispose();
    this._commentWidget.dispose();
    
    super.dispose();
  }

  /**
   * Set up collaborative features for the cell
   */
  private _setupCollaborativeFeatures(): void {
    // Add collaborative UI elements to the cell
    this.inputArea.node.appendChild(this._lockIndicator.node);
    this.inputArea.node.appendChild(this._presenceIndicator.node);
    this.inputArea.node.appendChild(this._commentWidget.node);
    
    // Set up editor integration for cursor tracking
    if (this.editor) {
      this._setupEditorIntegration();
    }
  }

  /**
   * Set up editor integration for collaborative features
   */
  private _setupEditorIntegration(): void {
    const editor = this.editor;
    if (!editor) {
      return;
    }

    // Track cursor position changes
    editor.onCursorPositionChanged.connect(() => {
      this._collaborativeOptions.awarenessService.trackCursorPosition(
        this.model.id,
        editor
      );
    });

    // Track selection changes
    editor.onSelectionChanged.connect(() => {
      const selection = editor.getSelection();
      if (selection) {
        this._presenceIndicator.highlightSelection(
          this._collaborativeOptions.awarenessService.getCurrentUser().userId,
          { start: selection.start.column, end: selection.end.column }
        );
      }
    });
  }
}

/**
 * Enhanced collaborative markdown cell with collaborative features
 */
export class CollaborativeMarkdownCell extends Cell {
  private _collaborativeOptions: ICollaborativeCellOptions;
  private _lockIndicator: CellLockIndicator;
  private _presenceIndicator: CellPresenceIndicator;
  private _commentWidget: CellCommentWidget;
  private _disposed: boolean = false;

  /**
   * Creates a new collaborative markdown cell
   * 
   * @param options - The collaborative cell options
   */
  constructor(options: ICollaborativeCellOptions) {
    super(options);
    this._collaborativeOptions = options;
    
    // Initialize collaborative components
    this._lockIndicator = new CellLockIndicator(
      options.model.id,
      options.lockService
    );
    this._presenceIndicator = new CellPresenceIndicator(
      options.model.id,
      options.awarenessService
    );
    this._commentWidget = new CellCommentWidget(
      options.model.id,
      options.commentService
    );
    
    this._setupCollaborativeFeatures();
  }

  /**
   * Get the lock indicator component
   */
  get lockIndicator(): CellLockIndicator {
    return this._lockIndicator;
  }

  /**
   * Get the presence indicator component
   */
  get presenceIndicator(): CellPresenceIndicator {
    return this._presenceIndicator;
  }

  /**
   * Get the comment widget component
   */
  get commentWidget(): CellCommentWidget {
    return this._commentWidget;
  }

  /**
   * Toggle the lock state of the cell
   */
  async toggleLock(): Promise<void> {
    try {
      const isLocked = await this._collaborativeOptions.lockService.isLocked(this.model.id);
      if (isLocked) {
        await this._collaborativeOptions.cellOperations.unlockCell(this.model.id);
      } else {
        await this._collaborativeOptions.cellOperations.lockCell(this.model.id);
      }
    } catch (error) {
      console.error('Error toggling cell lock:', error);
    }
  }

  /**
   * Show comments for the cell
   */
  showComments(): void {
    this._commentWidget.showComments();
  }

  /**
   * Hide comments for the cell
   */
  hideComments(): void {
    this._commentWidget.hideComments();
  }

  /**
   * Update presence information for the cell
   * 
   * @param presenceState - The new presence state
   */
  updatePresence(presenceState: IPresenceState): void {
    this._presenceIndicator.updatePresence(presenceState);
  }

  /**
   * Dispose of the collaborative markdown cell
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    
    this._lockIndicator.dispose();
    this._presenceIndicator.dispose();
    this._commentWidget.dispose();
    
    super.dispose();
  }

  /**
   * Set up collaborative features for the cell
   */
  private _setupCollaborativeFeatures(): void {
    // Add collaborative UI elements to the cell
    this.inputArea.node.appendChild(this._lockIndicator.node);
    this.inputArea.node.appendChild(this._presenceIndicator.node);
    this.inputArea.node.appendChild(this._commentWidget.node);
    
    // Set up editor integration for cursor tracking
    if (this.editor) {
      this._setupEditorIntegration();
    }
  }

  /**
   * Set up editor integration for collaborative features
   */
  private _setupEditorIntegration(): void {
    const editor = this.editor;
    if (!editor) {
      return;
    }

    // Track cursor position changes
    editor.onCursorPositionChanged.connect(() => {
      this._collaborativeOptions.awarenessService.trackCursorPosition(
        this.model.id,
        editor
      );
    });

    // Track selection changes
    editor.onSelectionChanged.connect(() => {
      const selection = editor.getSelection();
      if (selection) {
        this._presenceIndicator.highlightSelection(
          this._collaborativeOptions.awarenessService.getCurrentUser().userId,
          { start: selection.start.column, end: selection.end.column }
        );
      }
    });
  }
}

/**
 * Factory for creating collaborative cell instances
 */
export class CollaborativeCellFactory {
  private _collaborativeOptions: ICollaborativeCellOptions;
  private _disposed: boolean = false;

  /**
   * Creates a new collaborative cell factory
   * 
   * @param options - The collaborative cell options
   */
  constructor(options: ICollaborativeCellOptions) {
    this._collaborativeOptions = options;
  }

  /**
   * Supported cell types for collaborative editing
   */
  get supportedCellTypes(): string[] {
    return ['code', 'markdown', 'raw'];
  }

  /**
   * Create a collaborative code cell
   * 
   * @param options - Cell creation options
   * @returns A new collaborative code cell
   */
  createCodeCell(options: ICollaborativeCellOptions): CollaborativeCodeCell {
    return new CollaborativeCodeCell({
      ...this._collaborativeOptions,
      ...options
    });
  }

  /**
   * Create a collaborative markdown cell
   * 
   * @param options - Cell creation options
   * @returns A new collaborative markdown cell
   */
  createMarkdownCell(options: ICollaborativeCellOptions): CollaborativeMarkdownCell {
    return new CollaborativeMarkdownCell({
      ...this._collaborativeOptions,
      ...options
    });
  }

  /**
   * Create a collaborative raw cell
   * 
   * @param options - Cell creation options
   * @returns A new collaborative raw cell
   */
  createRawCell(options: ICollaborativeCellOptions): CollaborativeDefaultCell {
    return new CollaborativeDefaultCell({
      ...this._collaborativeOptions,
      ...options
    });
  }

  /**
   * Create a cell from a model
   * 
   * @param model - The cell model
   * @returns A new collaborative cell
   */
  createCellFromModel(model: ICellModel): CollaborativeCodeCell | CollaborativeMarkdownCell | CollaborativeDefaultCell {
    const options = {
      ...this._collaborativeOptions,
      model
    };

    switch (model.type) {
      case 'code':
        return this.createCodeCell(options);
      case 'markdown':
        return this.createMarkdownCell(options);
      case 'raw':
      default:
        return this.createRawCell(options);
    }
  }

  /**
   * Dispose of the factory
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
  }
}

/**
 * Enhanced collaborative default cell that serves as the base for all collaborative cells
 */
export class CollaborativeDefaultCell extends Cell {
  private _collaborativeOptions: ICollaborativeCellOptions;
  private _lockIndicator: CellLockIndicator;
  private _presenceIndicator: CellPresenceIndicator;
  private _commentWidget: CellCommentWidget;
  private _collaborativeFeatures: {
    lockingEnabled: boolean;
    presenceEnabled: boolean;
    commentsEnabled: boolean;
  };
  private _disposed: boolean = false;

  /**
   * Creates a new collaborative default cell
   * 
   * @param options - The collaborative cell options
   */
  constructor(options: ICollaborativeCellOptions) {
    super(options);
    this._collaborativeOptions = options;
    
    // Initialize collaborative features configuration
    this._collaborativeFeatures = {
      lockingEnabled: options.enableLocking ?? true,
      presenceEnabled: options.showPresence ?? true,
      commentsEnabled: options.enableComments ?? true
    };
    
    // Initialize collaborative components
    this._lockIndicator = new CellLockIndicator(
      options.model.id,
      options.lockService
    );
    this._presenceIndicator = new CellPresenceIndicator(
      options.model.id,
      options.awarenessService
    );
    this._commentWidget = new CellCommentWidget(
      options.model.id,
      options.commentService
    );
    
    this._setupCollaborativeFeatures();
  }

  /**
   * Get the lock indicator component
   */
  get lockIndicator(): CellLockIndicator {
    return this._lockIndicator;
  }

  /**
   * Get the presence indicator component
   */
  get presenceIndicator(): CellPresenceIndicator {
    return this._presenceIndicator;
  }

  /**
   * Get the comment widget component
   */
  get commentWidget(): CellCommentWidget {
    return this._commentWidget;
  }

  /**
   * Get the collaborative features configuration
   */
  get collaborativeFeatures(): {
    lockingEnabled: boolean;
    presenceEnabled: boolean;
    commentsEnabled: boolean;
  } {
    return { ...this._collaborativeFeatures };
  }

  /**
   * Toggle the lock state of the cell
   */
  async toggleLock(): Promise<void> {
    if (!this._collaborativeFeatures.lockingEnabled) {
      return;
    }

    try {
      const isLocked = await this._collaborativeOptions.lockService.isLocked(this.model.id);
      if (isLocked) {
        await this._collaborativeOptions.cellOperations.unlockCell(this.model.id);
      } else {
        await this._collaborativeOptions.cellOperations.lockCell(this.model.id);
      }
    } catch (error) {
      console.error('Error toggling cell lock:', error);
    }
  }

  /**
   * Show comments for the cell
   */
  showComments(): void {
    if (!this._collaborativeFeatures.commentsEnabled) {
      return;
    }
    this._commentWidget.showComments();
  }

  /**
   * Hide comments for the cell
   */
  hideComments(): void {
    if (!this._collaborativeFeatures.commentsEnabled) {
      return;
    }
    this._commentWidget.hideComments();
  }

  /**
   * Update presence information for the cell
   * 
   * @param presenceState - The new presence state
   */
  updatePresence(presenceState: IPresenceState): void {
    if (!this._collaborativeFeatures.presenceEnabled) {
      return;
    }
    this._presenceIndicator.updatePresence(presenceState);
  }

  /**
   * Initialize collaborative features for the cell
   */
  initializeCollaboration(): void {
    if (this._collaborativeOptions.collaborativeEnabled) {
      this._setupCollaborativeFeatures();
      this._subscribeToCollaborativeEvents();
    }
  }

  /**
   * Dispose of the collaborative default cell
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    
    this._lockIndicator.dispose();
    this._presenceIndicator.dispose();
    this._commentWidget.dispose();
    
    super.dispose();
  }

  /**
   * Set up collaborative features for the cell
   */
  private _setupCollaborativeFeatures(): void {
    // Add collaborative UI elements to the cell based on configuration
    if (this._collaborativeFeatures.lockingEnabled) {
      this.inputArea.node.appendChild(this._lockIndicator.node);
    }
    
    if (this._collaborativeFeatures.presenceEnabled) {
      this.inputArea.node.appendChild(this._presenceIndicator.node);
    }
    
    if (this._collaborativeFeatures.commentsEnabled) {
      this.inputArea.node.appendChild(this._commentWidget.node);
    }
    
    // Set up editor integration for cursor tracking
    if (this.editor) {
      this._setupEditorIntegration();
    }
  }

  /**
   * Set up editor integration for collaborative features
   */
  private _setupEditorIntegration(): void {
    const editor = this.editor;
    if (!editor || !this._collaborativeFeatures.presenceEnabled) {
      return;
    }

    // Track cursor position changes
    editor.onCursorPositionChanged.connect(() => {
      this._collaborativeOptions.awarenessService.trackCursorPosition(
        this.model.id,
        editor
      );
    });

    // Track selection changes
    editor.onSelectionChanged.connect(() => {
      const selection = editor.getSelection();
      if (selection) {
        this._presenceIndicator.highlightSelection(
          this._collaborativeOptions.awarenessService.getCurrentUser().userId,
          { start: selection.start.column, end: selection.end.column }
        );
      }
    });
  }

  /**
   * Subscribe to collaborative events
   */
  private _subscribeToCollaborativeEvents(): void {
    // Subscribe to cell operations events
    this._collaborativeOptions.cellOperations.onCellChange.connect((sender, args) => {
      if (args.cellId === this.model.id) {
        this._handleCellChange(args);
      }
    });

    // Subscribe to awareness events
    this._collaborativeOptions.awarenessService.onUserJoin.connect((sender, args) => {
      this._handleUserJoin(args);
    });

    this._collaborativeOptions.awarenessService.onUserLeave.connect((sender, args) => {
      this._handleUserLeave(args);
    });
  }

  /**
   * Handle cell change events
   */
  private _handleCellChange(args: {
    cellId: string;
    changeType: string;
    userId: string;
    timestamp: Date;
    data?: any;
  }): void {
    // Update collaborative indicators based on the change
    if (args.changeType === 'lock') {
      this._lockIndicator.updateStatus({
        isLocked: true,
        lockOwner: args.userId,
        lockOwnerName: args.data?.ownerName
      });
    } else if (args.changeType === 'unlock') {
      this._lockIndicator.updateStatus({
        isLocked: false
      });
    }
  }

  /**
   * Handle user join events
   */
  private _handleUserJoin(args: { userId: string; name: string; avatar?: string }): void {
    // Update presence indicators when users join
    if (this._collaborativeFeatures.presenceEnabled) {
      this._refreshPresenceState();
    }
  }

  /**
   * Handle user leave events
   */
  private _handleUserLeave(args: { userId: string }): void {
    // Update presence indicators when users leave
    if (this._collaborativeFeatures.presenceEnabled) {
      this._presenceIndicator.hideUserCursor(args.userId);
      this._refreshPresenceState();
    }
  }

  /**
   * Refresh presence state from awareness service
   */
  private _refreshPresenceState(): void {
    const users = this._collaborativeOptions.awarenessService.getUsers();
    const activeUsers = users.filter(user => 
      user.cursor?.cellId === this.model.id || user.selection?.cellId === this.model.id
    );
    
    this._presenceIndicator.updatePresence({
      activeUsers,
      cursorPositions: new Map(
        activeUsers
          .filter(user => user.cursor?.cellId === this.model.id)
          .map(user => [user.userId, { line: 0, column: user.cursor?.position || 0 }])
      ),
      selectionStates: new Map(
        activeUsers
          .filter(user => user.selection?.cellId === this.model.id)
          .map(user => [user.userId, { 
            start: user.selection?.start || 0, 
            end: user.selection?.end || 0 
          }])
      )
    });
  }
}

// Default export
export default CollaborativeDefaultCell;