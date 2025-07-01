/**
 * @fileoverview TypeScript type definitions and interfaces for the collaborative comment system
 * in Jupyter Notebook v7. This module defines the data structures for cell-level commenting,
 * threaded discussions, user presence, and resolution workflows integrated with Yjs CRDT
 * for real-time synchronization.
 * 
 * @author Blitzy Platform Team
 * @version 1.0.0
 * @since 2024-01-01
 */

import { JSONObject, JSONValue } from '@lumino/coreutils';
import { IUser } from '@jupyterlab/services';
import * as Y from 'yjs';

/**
 * Base interface for all comment-related entities with common properties
 * for tracking and versioning in the collaborative environment.
 */
export interface ICommentBase {
  /** Unique identifier for the comment entity */
  readonly id: string;
  /** Timestamp of when the entity was created (ISO 8601 format) */
  readonly createdAt: string;
  /** Timestamp of when the entity was last updated (ISO 8601 format) */
  readonly updatedAt: string;
  /** User who created this entity */
  readonly createdBy: ICommentUser;
  /** User who last modified this entity */
  readonly updatedBy: ICommentUser;
}

/**
 * User information interface for comment system with presence awareness capabilities.
 * Extends the base Jupyter user interface with collaboration-specific metadata.
 */
export interface ICommentUser extends IUser {
  /** User's display name in the comment system */
  readonly displayName: string;
  /** Avatar URL or base64 encoded image data */
  readonly avatar?: string;
  /** User's assigned color for presence indicators (hex format) */
  readonly color: string;
  /** User's current online status */
  readonly isOnline: boolean;
  /** User's current role in the collaborative session */
  readonly role: 'viewer' | 'editor' | 'admin';
  /** Timestamp of user's last activity (ISO 8601 format) */
  readonly lastActivity: string;
  /** User's current cursor position in the notebook */
  readonly cursorPosition?: {
    readonly cellId: string;
    readonly offset: number;
  };
}

/**
 * Individual comment interface representing a single comment in a thread.
 * Supports rich content, attachments, and hierarchical threading.
 */
export interface IComment extends ICommentBase {
  /** The comment content (supports markdown formatting) */
  content: string;
  /** Raw content as stored in Yjs document */
  readonly rawContent: JSONValue;
  /** ID of the parent comment (null for root comments) */
  readonly parentId: string | null;
  /** Nested level in the thread hierarchy (0 for root comments) */
  readonly level: number;
  /** Array of direct reply comment IDs */
  readonly replies: readonly string[];
  /** Comment status in the resolution workflow */
  status: CommentStatus;
  /** Metadata for comment resolution tracking */
  readonly resolution?: ICommentResolution;
  /** Optional attachments associated with the comment */
  readonly attachments?: readonly ICommentAttachment[];
  /** Reactions to the comment */
  readonly reactions: readonly ICommentReaction[];
  /** Whether the comment has been edited */
  readonly isEdited: boolean;
  /** History of edits for audit trail */
  readonly editHistory?: readonly ICommentEdit[];
  /** Mention metadata for user notifications */
  readonly mentions: readonly ICommentMention[];
  /** Tags associated with the comment for categorization */
  readonly tags?: readonly string[];
  /** Priority level for the comment */
  readonly priority: CommentPriority;
}

/**
 * Comment thread interface for managing collections of comments associated with a cell.
 * Provides thread-level metadata and operations for collaborative discussions.
 */
export interface ICommentThread extends ICommentBase {
  /** ID of the cell this thread is associated with */
  readonly cellId: string;
  /** Thread title for better organization */
  title?: string;
  /** Array of all comment IDs in this thread (chronological order) */
  readonly commentIds: readonly string[];
  /** Root comment ID (first comment in the thread) */
  readonly rootCommentId: string;
  /** Total number of comments in the thread */
  readonly commentCount: number;
  /** Thread status in the resolution workflow */
  status: CommentThreadStatus;
  /** Thread resolution metadata */
  readonly resolution?: ICommentResolution;
  /** Users participating in this thread */
  readonly participants: readonly ICommentUser[];
  /** Whether the thread is currently active */
  readonly isActive: boolean;
  /** Thread visibility settings */
  readonly visibility: CommentVisibility;
  /** Notification settings for the thread */
  readonly notifications: ICommentNotificationSettings;
  /** Thread metadata for categorization and filtering */
  readonly metadata: JSONObject;
  /** Last activity timestamp for sorting and filtering */
  readonly lastActivityAt: string;
  /** Whether the thread is pinned */
  readonly isPinned: boolean;
  /** Thread subscription information */
  readonly subscriptions: readonly ICommentSubscription[];
}

/**
 * Comment resolution interface for tracking the resolution workflow.
 * Supports both individual comment resolution and thread-level resolution.
 */
export interface ICommentResolution extends ICommentBase {
  /** User who resolved the comment/thread */
  readonly resolvedBy: ICommentUser;
  /** Timestamp when resolution occurred (ISO 8601 format) */
  readonly resolvedAt: string;
  /** Resolution reason or notes */
  readonly reason?: string;
  /** Resolution type */
  readonly type: CommentResolutionType;
  /** Whether resolution can be reopened */
  readonly canReopen: boolean;
  /** Auto-resolution settings */
  readonly autoResolution?: {
    readonly enabled: boolean;
    readonly timeoutHours: number;
    readonly conditions: readonly string[];
  };
}

/**
 * Comment attachment interface for file attachments in comments.
 * Supports various file types with metadata and access control.
 */
export interface ICommentAttachment {
  /** Unique identifier for the attachment */
  readonly id: string;
  /** Original filename */
  readonly filename: string;
  /** MIME type of the attachment */
  readonly mimeType: string;
  /** File size in bytes */
  readonly size: number;
  /** Download URL or base64 encoded data */
  readonly url: string;
  /** Thumbnail URL for image attachments */
  readonly thumbnailUrl?: string;
  /** Upload timestamp (ISO 8601 format) */
  readonly uploadedAt: string;
  /** User who uploaded the attachment */
  readonly uploadedBy: ICommentUser;
  /** Attachment metadata */
  readonly metadata?: JSONObject;
}

/**
 * Comment reaction interface for emoji reactions to comments.
 * Supports custom emoji and reaction analytics.
 */
export interface ICommentReaction {
  /** Emoji code or custom emoji identifier */
  readonly emoji: string;
  /** Users who reacted with this emoji */
  readonly users: readonly ICommentUser[];
  /** Total count of this reaction */
  readonly count: number;
  /** Timestamp of first reaction (ISO 8601 format) */
  readonly firstReactionAt: string;
  /** Timestamp of last reaction (ISO 8601 format) */
  readonly lastReactionAt: string;
}

/**
 * Comment edit history interface for tracking comment modifications.
 * Provides audit trail and version control for comments.
 */
export interface ICommentEdit {
  /** Unique identifier for the edit */
  readonly id: string;
  /** Previous content before edit */
  readonly previousContent: string;
  /** New content after edit */
  readonly newContent: string;
  /** User who made the edit */
  readonly editedBy: ICommentUser;
  /** Edit timestamp (ISO 8601 format) */
  readonly editedAt: string;
  /** Reason for the edit */
  readonly reason?: string;
  /** Content diff for visualization */
  readonly diff?: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly modified: readonly string[];
  };
}

/**
 * Comment mention interface for user mentions in comments.
 * Supports notification delivery and mention analytics.
 */
export interface ICommentMention {
  /** Mentioned user */
  readonly user: ICommentUser;
  /** Position of mention in comment content */
  readonly position: {
    readonly start: number;
    readonly end: number;
  };
  /** Whether the mention was delivered */
  readonly delivered: boolean;
  /** Mention delivery timestamp (ISO 8601 format) */
  readonly deliveredAt?: string;
  /** Mention type */
  readonly type: CommentMentionType;
}

/**
 * Comment subscription interface for managing thread notifications.
 * Allows users to control their notification preferences per thread.
 */
export interface ICommentSubscription {
  /** Subscribed user */
  readonly user: ICommentUser;
  /** Subscription type */
  readonly type: CommentSubscriptionType;
  /** Subscription timestamp (ISO 8601 format) */
  readonly subscribedAt: string;
  /** Notification preferences */
  readonly preferences: ICommentNotificationSettings;
  /** Whether subscription is active */
  readonly isActive: boolean;
}

/**
 * Comment notification settings interface for controlling notification delivery.
 * Supports granular control over different types of notifications.
 */
export interface ICommentNotificationSettings {
  /** Enable notifications for new comments */
  readonly newComments: boolean;
  /** Enable notifications for replies to user's comments */
  readonly replies: boolean;
  /** Enable notifications for mentions */
  readonly mentions: boolean;
  /** Enable notifications for resolutions */
  readonly resolutions: boolean;
  /** Enable notifications for reactions */
  readonly reactions: boolean;
  /** Notification delivery method */
  readonly deliveryMethod: CommentNotificationDeliveryMethod;
  /** Notification frequency */
  readonly frequency: CommentNotificationFrequency;
  /** Quiet hours for notifications */
  readonly quietHours?: {
    readonly start: string;
    readonly end: string;
    readonly timezone: string;
  };
}

/**
 * Yjs-compatible comment data structure for real-time synchronization.
 * Represents the comment data as stored in the Yjs Y.Map structure.
 */
export interface IYjsCommentData {
  /** Comment metadata stored in Y.Map */
  readonly metadata: Y.Map<JSONValue>;
  /** Comment content stored in Y.Text for collaborative editing */
  readonly content: Y.Text;
  /** Comment attributes stored in Y.Map */
  readonly attributes: Y.Map<JSONValue>;
  /** Comment replies stored in Y.Array */
  readonly replies: Y.Array<string>;
  /** Comment reactions stored in Y.Array */
  readonly reactions: Y.Array<Y.Map<JSONValue>>;
  /** Comment edit history stored in Y.Array */
  readonly editHistory: Y.Array<Y.Map<JSONValue>>;
}

/**
 * Yjs-compatible comment thread data structure for real-time synchronization.
 * Represents the thread data as stored in the Yjs Y.Map structure.
 */
export interface IYjsCommentThreadData {
  /** Thread metadata stored in Y.Map */
  readonly metadata: Y.Map<JSONValue>;
  /** Thread comments stored in Y.Array */
  readonly comments: Y.Array<string>;
  /** Thread participants stored in Y.Array */
  readonly participants: Y.Array<Y.Map<JSONValue>>;
  /** Thread resolution data stored in Y.Map */
  readonly resolution: Y.Map<JSONValue>;
  /** Thread subscriptions stored in Y.Array */
  readonly subscriptions: Y.Array<Y.Map<JSONValue>>;
}

/**
 * Comment container interface for organizing comments by cell.
 * Provides efficient access to comments and threads for a specific cell.
 */
export interface ICommentContainer {
  /** Cell ID this container is associated with */
  readonly cellId: string;
  /** Map of comment IDs to comment objects */
  readonly comments: ReadonlyMap<string, IComment>;
  /** Map of thread IDs to thread objects */
  readonly threads: ReadonlyMap<string, ICommentThread>;
  /** Active thread ID (currently being viewed/edited) */
  readonly activeThreadId?: string;
  /** Container metadata */
  readonly metadata: JSONObject;
  /** Container creation timestamp (ISO 8601 format) */
  readonly createdAt: string;
  /** Container last update timestamp (ISO 8601 format) */
  readonly updatedAt: string;
  /** Whether container has unread comments */
  readonly hasUnread: boolean;
  /** Unread comment count */
  readonly unreadCount: number;
}

/**
 * Comment system state interface for managing global comment state.
 * Provides centralized state management for the comment system.
 */
export interface ICommentSystemState {
  /** Map of cell IDs to comment containers */
  readonly containers: ReadonlyMap<string, ICommentContainer>;
  /** Currently active cell ID for commenting */
  readonly activeCellId?: string;
  /** Current user information */
  readonly currentUser: ICommentUser;
  /** Global comment system settings */
  readonly settings: ICommentSystemSettings;
  /** System-wide notification settings */
  readonly notifications: ICommentNotificationSettings;
  /** Comment system status */
  readonly status: CommentSystemStatus;
  /** Connection state for real-time synchronization */
  readonly connectionState: CommentConnectionState;
  /** Pending operations for offline support */
  readonly pendingOperations: readonly ICommentOperation[];
}

/**
 * Comment system settings interface for configuration management.
 * Provides global settings for the comment system behavior.
 */
export interface ICommentSystemSettings {
  /** Enable/disable comment system */
  readonly enabled: boolean;
  /** Maximum comments per thread */
  readonly maxCommentsPerThread: number;
  /** Maximum thread depth */
  readonly maxThreadDepth: number;
  /** Auto-save interval in milliseconds */
  readonly autoSaveInterval: number;
  /** Comment character limit */
  readonly commentCharacterLimit: number;
  /** Enable rich text formatting */
  readonly richTextEnabled: boolean;
  /** Enable file attachments */
  readonly attachmentsEnabled: boolean;
  /** Maximum attachment size in bytes */
  readonly maxAttachmentSize: number;
  /** Allowed attachment types */
  readonly allowedAttachmentTypes: readonly string[];
  /** Enable emoji reactions */
  readonly reactionsEnabled: boolean;
  /** Enable user mentions */
  readonly mentionsEnabled: boolean;
  /** Enable comment resolution */
  readonly resolutionEnabled: boolean;
  /** Auto-resolution timeout in hours */
  readonly autoResolutionTimeout: number;
  /** Comment moderation settings */
  readonly moderation: ICommentModerationSettings;
}

/**
 * Comment moderation settings interface for content control.
 * Provides settings for comment moderation and content filtering.
 */
export interface ICommentModerationSettings {
  /** Enable comment moderation */
  readonly enabled: boolean;
  /** Auto-moderation rules */
  readonly autoModeration: readonly ICommentModerationRule[];
  /** Profanity filter enabled */
  readonly profanityFilter: boolean;
  /** Spam detection enabled */
  readonly spamDetection: boolean;
  /** Require approval for new comments */
  readonly requireApproval: boolean;
  /** Moderator user IDs */
  readonly moderators: readonly string[];
  /** Content filtering rules */
  readonly contentFilters: readonly string[];
}

/**
 * Comment moderation rule interface for automated content filtering.
 * Defines rules for automatic comment moderation.
 */
export interface ICommentModerationRule {
  /** Rule identifier */
  readonly id: string;
  /** Rule name */
  readonly name: string;
  /** Rule description */
  readonly description: string;
  /** Rule pattern (regex) */
  readonly pattern: string;
  /** Rule action */
  readonly action: CommentModerationAction;
  /** Rule severity */
  readonly severity: CommentModerationSeverity;
  /** Rule enabled status */
  readonly enabled: boolean;
}

/**
 * Comment operation interface for tracking operations in offline mode.
 * Provides operation queuing and synchronization for offline support.
 */
export interface ICommentOperation {
  /** Operation identifier */
  readonly id: string;
  /** Operation type */
  readonly type: CommentOperationType;
  /** Operation payload */
  readonly payload: JSONObject;
  /** Operation timestamp (ISO 8601 format) */
  readonly timestamp: string;
  /** Operation status */
  readonly status: CommentOperationStatus;
  /** Operation retry count */
  readonly retryCount: number;
  /** Operation error message */
  readonly error?: string;
  /** Operation dependencies */
  readonly dependencies: readonly string[];
}

/**
 * Comment event interface for the notification system.
 * Represents events that can trigger notifications or other actions.
 */
export interface ICommentEvent {
  /** Event identifier */
  readonly id: string;
  /** Event type */
  readonly type: CommentEventType;
  /** Event source (user, system, etc.) */
  readonly source: CommentEventSource;
  /** Event target (comment, thread, etc.) */
  readonly target: CommentEventTarget;
  /** Event payload */
  readonly payload: JSONObject;
  /** Event timestamp (ISO 8601 format) */
  readonly timestamp: string;
  /** Event metadata */
  readonly metadata?: JSONObject;
  /** Event recipients */
  readonly recipients: readonly string[];
  /** Event delivery status */
  readonly deliveryStatus: CommentEventDeliveryStatus;
}

/**
 * Enumeration of comment status values for individual comments.
 */
export enum CommentStatus {
  /** Comment is active and visible */
  ACTIVE = 'active',
  /** Comment is pending approval */
  PENDING = 'pending',
  /** Comment has been resolved */
  RESOLVED = 'resolved',
  /** Comment has been deleted */
  DELETED = 'deleted',
  /** Comment has been archived */
  ARCHIVED = 'archived',
  /** Comment has been flagged for moderation */
  FLAGGED = 'flagged',
  /** Comment has been edited */
  EDITED = 'edited',
  /** Comment is in draft state */
  DRAFT = 'draft'
}

/**
 * Enumeration of comment thread status values.
 */
export enum CommentThreadStatus {
  /** Thread is open and active */
  OPEN = 'open',
  /** Thread has been resolved */
  RESOLVED = 'resolved',
  /** Thread has been closed */
  CLOSED = 'closed',
  /** Thread has been locked */
  LOCKED = 'locked',
  /** Thread has been archived */
  ARCHIVED = 'archived',
  /** Thread is pinned */
  PINNED = 'pinned'
}

/**
 * Enumeration of comment priority levels.
 */
export enum CommentPriority {
  /** Low priority comment */
  LOW = 'low',
  /** Normal priority comment */
  NORMAL = 'normal',
  /** High priority comment */
  HIGH = 'high',
  /** Critical priority comment */
  CRITICAL = 'critical'
}

/**
 * Enumeration of comment visibility settings.
 */
export enum CommentVisibility {
  /** Comment is visible to all users */
  PUBLIC = 'public',
  /** Comment is visible to participants only */
  PRIVATE = 'private',
  /** Comment is visible to specific users */
  RESTRICTED = 'restricted',
  /** Comment is hidden */
  HIDDEN = 'hidden'
}

/**
 * Enumeration of comment resolution types.
 */
export enum CommentResolutionType {
  /** Comment was resolved by the author */
  AUTHOR_RESOLVED = 'author_resolved',
  /** Comment was resolved by a moderator */
  MODERATOR_RESOLVED = 'moderator_resolved',
  /** Comment was auto-resolved */
  AUTO_RESOLVED = 'auto_resolved',
  /** Comment was resolved by consensus */
  CONSENSUS_RESOLVED = 'consensus_resolved'
}

/**
 * Enumeration of comment mention types.
 */
export enum CommentMentionType {
  /** Direct user mention */
  USER = 'user',
  /** Role-based mention */
  ROLE = 'role',
  /** Group mention */
  GROUP = 'group',
  /** Everyone mention */
  EVERYONE = 'everyone'
}

/**
 * Enumeration of comment subscription types.
 */
export enum CommentSubscriptionType {
  /** Subscribe to all activities */
  ALL = 'all',
  /** Subscribe to new comments only */
  COMMENTS = 'comments',
  /** Subscribe to replies only */
  REPLIES = 'replies',
  /** Subscribe to mentions only */
  MENTIONS = 'mentions',
  /** Subscribe to resolutions only */
  RESOLUTIONS = 'resolutions'
}

/**
 * Enumeration of notification delivery methods.
 */
export enum CommentNotificationDeliveryMethod {
  /** In-app notifications only */
  IN_APP = 'in_app',
  /** Email notifications */
  EMAIL = 'email',
  /** Push notifications */
  PUSH = 'push',
  /** All notification methods */
  ALL = 'all',
  /** No notifications */
  NONE = 'none'
}

/**
 * Enumeration of notification frequency settings.
 */
export enum CommentNotificationFrequency {
  /** Immediate notifications */
  IMMEDIATE = 'immediate',
  /** Hourly digest */
  HOURLY = 'hourly',
  /** Daily digest */
  DAILY = 'daily',
  /** Weekly digest */
  WEEKLY = 'weekly',
  /** Never send notifications */
  NEVER = 'never'
}

/**
 * Enumeration of comment system status values.
 */
export enum CommentSystemStatus {
  /** System is active and fully functional */
  ACTIVE = 'active',
  /** System is initializing */
  INITIALIZING = 'initializing',
  /** System is offline */
  OFFLINE = 'offline',
  /** System is in maintenance mode */
  MAINTENANCE = 'maintenance',
  /** System has encountered an error */
  ERROR = 'error',
  /** System is synchronizing */
  SYNCHRONIZING = 'synchronizing'
}

/**
 * Enumeration of comment connection states for real-time sync.
 */
export enum CommentConnectionState {
  /** Connected and synchronized */
  CONNECTED = 'connected',
  /** Connecting to server */
  CONNECTING = 'connecting',
  /** Disconnected from server */
  DISCONNECTED = 'disconnected',
  /** Connection failed */
  FAILED = 'failed',
  /** Reconnecting to server */
  RECONNECTING = 'reconnecting',
  /** Offline mode */
  OFFLINE = 'offline'
}

/**
 * Enumeration of comment moderation actions.
 */
export enum CommentModerationAction {
  /** Allow comment */
  ALLOW = 'allow',
  /** Block comment */
  BLOCK = 'block',
  /** Flag comment for review */
  FLAG = 'flag',
  /** Require approval */
  REQUIRE_APPROVAL = 'require_approval',
  /** Auto-delete comment */
  DELETE = 'delete',
  /** Move to spam */
  SPAM = 'spam'
}

/**
 * Enumeration of comment moderation severity levels.
 */
export enum CommentModerationSeverity {
  /** Low severity */
  LOW = 'low',
  /** Medium severity */
  MEDIUM = 'medium',
  /** High severity */
  HIGH = 'high',
  /** Critical severity */
  CRITICAL = 'critical'
}

/**
 * Enumeration of comment operation types for offline support.
 */
export enum CommentOperationType {
  /** Create new comment */
  CREATE_COMMENT = 'create_comment',
  /** Update existing comment */
  UPDATE_COMMENT = 'update_comment',
  /** Delete comment */
  DELETE_COMMENT = 'delete_comment',
  /** Create new thread */
  CREATE_THREAD = 'create_thread',
  /** Update thread */
  UPDATE_THREAD = 'update_thread',
  /** Delete thread */
  DELETE_THREAD = 'delete_thread',
  /** Resolve comment */
  RESOLVE_COMMENT = 'resolve_comment',
  /** Add reaction */
  ADD_REACTION = 'add_reaction',
  /** Remove reaction */
  REMOVE_REACTION = 'remove_reaction',
  /** Subscribe to thread */
  SUBSCRIBE = 'subscribe',
  /** Unsubscribe from thread */
  UNSUBSCRIBE = 'unsubscribe'
}

/**
 * Enumeration of comment operation status values.
 */
export enum CommentOperationStatus {
  /** Operation is pending */
  PENDING = 'pending',
  /** Operation is in progress */
  IN_PROGRESS = 'in_progress',
  /** Operation completed successfully */
  SUCCESS = 'success',
  /** Operation failed */
  FAILED = 'failed',
  /** Operation was cancelled */
  CANCELLED = 'cancelled',
  /** Operation is retrying */
  RETRYING = 'retrying'
}

/**
 * Enumeration of comment event types for the notification system.
 */
export enum CommentEventType {
  /** New comment created */
  COMMENT_CREATED = 'comment_created',
  /** Comment updated */
  COMMENT_UPDATED = 'comment_updated',
  /** Comment deleted */
  COMMENT_DELETED = 'comment_deleted',
  /** Comment resolved */
  COMMENT_RESOLVED = 'comment_resolved',
  /** Comment reaction added */
  COMMENT_REACTION_ADDED = 'comment_reaction_added',
  /** Comment reaction removed */
  COMMENT_REACTION_REMOVED = 'comment_reaction_removed',
  /** User mentioned in comment */
  COMMENT_MENTION = 'comment_mention',
  /** Thread created */
  THREAD_CREATED = 'thread_created',
  /** Thread updated */
  THREAD_UPDATED = 'thread_updated',
  /** Thread resolved */
  THREAD_RESOLVED = 'thread_resolved',
  /** Thread closed */
  THREAD_CLOSED = 'thread_closed',
  /** User subscribed to thread */
  THREAD_SUBSCRIBED = 'thread_subscribed',
  /** User unsubscribed from thread */
  THREAD_UNSUBSCRIBED = 'thread_unsubscribed',
  /** System notification */
  SYSTEM_NOTIFICATION = 'system_notification'
}

/**
 * Enumeration of comment event sources.
 */
export enum CommentEventSource {
  /** Event from user action */
  USER = 'user',
  /** Event from system action */
  SYSTEM = 'system',
  /** Event from automation */
  AUTOMATION = 'automation',
  /** Event from moderation */
  MODERATION = 'moderation',
  /** Event from integration */
  INTEGRATION = 'integration'
}

/**
 * Enumeration of comment event targets.
 */
export enum CommentEventTarget {
  /** Event targets a comment */
  COMMENT = 'comment',
  /** Event targets a thread */
  THREAD = 'thread',
  /** Event targets a user */
  USER = 'user',
  /** Event targets the system */
  SYSTEM = 'system',
  /** Event targets a cell */
  CELL = 'cell'
}

/**
 * Enumeration of comment event delivery status.
 */
export enum CommentEventDeliveryStatus {
  /** Event pending delivery */
  PENDING = 'pending',
  /** Event delivered successfully */
  DELIVERED = 'delivered',
  /** Event delivery failed */
  FAILED = 'failed',
  /** Event delivery was skipped */
  SKIPPED = 'skipped',
  /** Event delivery was cancelled */
  CANCELLED = 'cancelled'
}

/**
 * Type guard function to check if an object is an IComment.
 * @param obj - Object to check
 * @returns True if object is an IComment
 */
export function isIComment(obj: unknown): obj is IComment {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as IComment).id === 'string' &&
    typeof (obj as IComment).content === 'string' &&
    typeof (obj as IComment).createdAt === 'string' &&
    typeof (obj as IComment).createdBy === 'object' &&
    Array.isArray((obj as IComment).replies) &&
    Object.values(CommentStatus).includes((obj as IComment).status)
  );
}

/**
 * Type guard function to check if an object is an ICommentThread.
 * @param obj - Object to check
 * @returns True if object is an ICommentThread
 */
export function isICommentThread(obj: unknown): obj is ICommentThread {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as ICommentThread).id === 'string' &&
    typeof (obj as ICommentThread).cellId === 'string' &&
    Array.isArray((obj as ICommentThread).commentIds) &&
    typeof (obj as ICommentThread).rootCommentId === 'string' &&
    Object.values(CommentThreadStatus).includes((obj as ICommentThread).status)
  );
}

/**
 * Type guard function to check if an object is an ICommentUser.
 * @param obj - Object to check
 * @returns True if object is an ICommentUser
 */
export function isICommentUser(obj: unknown): obj is ICommentUser {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as ICommentUser).username === 'string' &&
    typeof (obj as ICommentUser).displayName === 'string' &&
    typeof (obj as ICommentUser).color === 'string' &&
    typeof (obj as ICommentUser).isOnline === 'boolean' &&
    ['viewer', 'editor', 'admin'].includes((obj as ICommentUser).role)
  );
}

/**
 * Utility type for partial comment updates.
 */
export type PartialComment = Partial<Omit<IComment, 'id' | 'createdAt' | 'createdBy'>>;

/**
 * Utility type for partial thread updates.
 */
export type PartialCommentThread = Partial<Omit<ICommentThread, 'id' | 'cellId' | 'createdAt' | 'createdBy'>>;

/**
 * Utility type for comment creation payload.
 */
export type CreateCommentPayload = Pick<IComment, 'content' | 'parentId'> & {
  readonly cellId: string;
  readonly mentions?: readonly ICommentMention[];
  readonly attachments?: readonly ICommentAttachment[];
  readonly tags?: readonly string[];
  readonly priority?: CommentPriority;
};

/**
 * Utility type for thread creation payload.
 */
export type CreateThreadPayload = Pick<ICommentThread, 'cellId'> & {
  readonly title?: string;
  readonly initialComment: CreateCommentPayload;
  readonly visibility?: CommentVisibility;
  readonly notifications?: ICommentNotificationSettings;
};

/**
 * Utility type for comment event payload.
 */
export type CommentEventPayload = {
  readonly commentId?: string;
  readonly threadId?: string;
  readonly userId?: string;
  readonly cellId?: string;
  readonly action?: string;
  readonly data?: JSONObject;
  readonly metadata?: JSONObject;
};

/**
 * Utility type for Yjs document structure containing all comment data.
 */
export type YjsCommentDocument = {
  readonly comments: Y.Map<IYjsCommentData>;
  readonly threads: Y.Map<IYjsCommentThreadData>;
  readonly users: Y.Map<Y.Map<JSONValue>>;
  readonly metadata: Y.Map<JSONValue>;
};

/**
 * Default comment system settings.
 */
export const DEFAULT_COMMENT_SYSTEM_SETTINGS: ICommentSystemSettings = {
  enabled: true,
  maxCommentsPerThread: 100,
  maxThreadDepth: 10,
  autoSaveInterval: 5000,
  commentCharacterLimit: 5000,
  richTextEnabled: true,
  attachmentsEnabled: true,
  maxAttachmentSize: 10 * 1024 * 1024, // 10MB
  allowedAttachmentTypes: ['image/jpeg', 'image/png', 'image/gif', 'text/plain', 'application/pdf'],
  reactionsEnabled: true,
  mentionsEnabled: true,
  resolutionEnabled: true,
  autoResolutionTimeout: 168, // 7 days
  moderation: {
    enabled: false,
    autoModeration: [],
    profanityFilter: false,
    spamDetection: false,
    requireApproval: false,
    moderators: [],
    contentFilters: []
  }
};

/**
 * Default notification settings.
 */
export const DEFAULT_NOTIFICATION_SETTINGS: ICommentNotificationSettings = {
  newComments: true,
  replies: true,
  mentions: true,
  resolutions: true,
  reactions: false,
  deliveryMethod: CommentNotificationDeliveryMethod.IN_APP,
  frequency: CommentNotificationFrequency.IMMEDIATE
};