/**
 * @fileoverview In-notebook comment and review system for collaborative editing.
 * 
 * This module provides comprehensive commenting and review capabilities for collaborative 
 * Jupyter Notebook editing sessions. It enables threaded discussions, real-time comment
 * synchronization, and precise cell-level annotation with robust notification workflows.
 * 
 * Key Features:
 * - MongoDB-backed comment storage with BSON document structure
 * - Real-time comment synchronization via WebSocket broadcasting
 * - Threaded discussion support with nested reply capabilities
 * - Precise cell and line-level comment anchoring
 * - Full-text search and filtering with MongoDB indexing
 * - Configurable notification system with alert policies
 * - Comment resolution workflows with status tracking
 * - Export/import functionality for workflow integration
 * - Seamless integration with collaborative editing infrastructure
 * 
 * Architecture:
 * - Integrates with YjsNotebookProvider for real-time collaboration
 * - Uses Awareness system for user context and presence
 * - MongoDB collections for persistent comment storage
 * - WebSocket channels for instant comment propagation
 * - Event-driven notification system
 * - Full-text search indices for comment discovery
 * 
 * @author Jupyter Notebook Collaboration Team
 * @version 7.5.0-alpha.0
 * @since 2024-12-15
 */

import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { 
    IDisposable, 
    IObservableDisposable 
} from '@lumino/disposable';
import { 
    ISignal, 
    Signal 
} from '@lumino/signaling';
import { 
    JSONObject, 
    JSONValue, 
    UUID 
} from '@lumino/coreutils';

// Import collaboration dependencies
import { 
    ICollaborationProvider,
    YjsNotebookProvider,
    IProviderEvent,
    ConnectionState
} from './YjsNotebookProvider';
import { 
    CollaborativeAwareness,
    IUserPresence,
    ActivityStatus,
    UserRole,
    IAwarenessEvent,
    AwarenessEventType
} from './awareness';

/**
 * Comment data structure representing a single comment instance.
 */
export interface IComment {
    /** Unique comment identifier */
    commentId: string;
    
    /** Parent comment ID for threaded replies (null for top-level comments) */
    parentId: string | null;
    
    /** Thread root ID for efficient thread querying */
    threadId: string;
    
    /** Comment content with rich text support */
    content: ICommentContent;
    
    /** User who created the comment */
    author: ICommentAuthor;
    
    /** Comment anchoring information */
    anchor: ICommentAnchor;
    
    /** Comment metadata and status */
    metadata: ICommentMetadata;
    
    /** Timestamps for lifecycle tracking */
    timestamps: ICommentTimestamps;
    
    /** Comment visibility and access control */
    visibility: ICommentVisibility;
    
    /** Comment tags and categorization */
    tags: string[];
    
    /** Attachments and referenced content */
    attachments: ICommentAttachment[];
}

/**
 * Comment content with rich text and formatting support.
 */
export interface ICommentContent {
    /** Plain text content for search and fallback */
    text: string;
    
    /** Rich text content in HTML format */
    html?: string;
    
    /** Markdown source if applicable */
    markdown?: string;
    
    /** Delta format for rich text editors */
    delta?: JSONObject;
    
    /** Content format type */
    format: CommentContentFormat;
    
    /** Mentions of other users */
    mentions: ICommentMention[];
    
    /** Links to external resources */
    links: ICommentLink[];
}

/**
 * Comment content format enumeration.
 */
export enum CommentContentFormat {
    PLAIN_TEXT = 'text',
    MARKDOWN = 'markdown',
    HTML = 'html',
    RICH_TEXT = 'rich',
    DELTA = 'delta'
}

/**
 * User mention within comment content.
 */
export interface ICommentMention {
    /** Mentioned user ID */
    userId: string;
    
    /** Display name at time of mention */
    displayName: string;
    
    /** Character offset in content */
    offset: number;
    
    /** Length of mention text */
    length: number;
    
    /** Mention type (user, role, team) */
    type: MentionType;
}

/**
 * Mention type enumeration.
 */
export enum MentionType {
    USER = 'user',
    ROLE = 'role',
    TEAM = 'team',
    ALL = 'all'
}

/**
 * External link within comment content.
 */
export interface ICommentLink {
    /** Link URL */
    url: string;
    
    /** Link title or description */
    title?: string;
    
    /** Character offset in content */
    offset: number;
    
    /** Length of link text */
    length: number;
    
    /** Link type (internal, external, cell, output) */
    type: LinkType;
}

/**
 * Link type enumeration.
 */
export enum LinkType {
    EXTERNAL = 'external',
    INTERNAL = 'internal',
    CELL_REFERENCE = 'cell',
    OUTPUT_REFERENCE = 'output',
    NOTEBOOK_REFERENCE = 'notebook'
}

/**
 * Comment author information.
 */
export interface ICommentAuthor {
    /** User ID from authentication system */
    userId: string;
    
    /** Display name at time of comment creation */
    displayName: string;
    
    /** User avatar URL */
    avatar?: string;
    
    /** User role in the session */
    role: UserRole;
    
    /** User email for notifications */
    email?: string;
    
    /** Custom user metadata */
    metadata?: JSONObject;
}

/**
 * Comment anchoring information for precise positioning.
 */
export interface ICommentAnchor {
    /** Target cell ID */
    cellId: string;
    
    /** Anchor type (cell, line, selection, output) */
    type: CommentAnchorType;
    
    /** Line number within cell (for line-level comments) */
    lineNumber?: number;
    
    /** Character offset within line */
    characterOffset?: number;
    
    /** Selection range for text selections */
    selectionRange?: ISelectionRange;
    
    /** Output index for output-specific comments */
    outputIndex?: number;
    
    /** Stable anchor context for conflict resolution */
    context: IAnchorContext;
}

/**
 * Comment anchor type enumeration.
 */
export enum CommentAnchorType {
    CELL = 'cell',
    LINE = 'line',
    SELECTION = 'selection',
    OUTPUT = 'output',
    CELL_METADATA = 'metadata'
}

/**
 * Text selection range information.
 */
export interface ISelectionRange {
    /** Start line number */
    startLine: number;
    
    /** Start character offset */
    startCharacter: number;
    
    /** End line number */
    endLine: number;
    
    /** End character offset */
    endCharacter: number;
    
    /** Selected text content */
    selectedText: string;
}

/**
 * Anchor context for stable positioning across edits.
 */
export interface IAnchorContext {
    /** Surrounding text context for position recovery */
    beforeText: string;
    
    /** Text content at anchor position */
    anchorText: string;
    
    /** Text context after anchor position */
    afterText: string;
    
    /** Cell content hash at time of anchoring */
    cellContentHash: string;
    
    /** Context length for conflict resolution */
    contextLength: number;
}

/**
 * Comment metadata and status information.
 */
export interface ICommentMetadata {
    /** Comment status (active, resolved, deleted) */
    status: CommentStatus;
    
    /** Resolution information */
    resolution?: ICommentResolution;
    
    /** Comment priority level */
    priority: CommentPriority;
    
    /** Comment type (annotation, review, suggestion) */
    type: CommentType;
    
    /** Custom metadata fields */
    custom: JSONObject;
    
    /** Comment version for edit history */
    version: number;
    
    /** Last edit information */
    lastEdit?: ICommentEdit;
}

/**
 * Comment status enumeration.
 */
export enum CommentStatus {
    ACTIVE = 'active',
    RESOLVED = 'resolved',
    DELETED = 'deleted',
    ARCHIVED = 'archived',
    DRAFT = 'draft'
}

/**
 * Comment priority enumeration.
 */
export enum CommentPriority {
    LOW = 'low',
    NORMAL = 'normal',
    HIGH = 'high',
    URGENT = 'urgent'
}

/**
 * Comment type enumeration.
 */
export enum CommentType {
    ANNOTATION = 'annotation',
    REVIEW = 'review',
    SUGGESTION = 'suggestion',
    QUESTION = 'question',
    DISCUSSION = 'discussion',
    TODO = 'todo'
}

/**
 * Comment resolution information.
 */
export interface ICommentResolution {
    /** User who resolved the comment */
    resolvedBy: string;
    
    /** Resolution timestamp */
    resolvedAt: Date;
    
    /** Resolution reason or note */
    reason?: string;
    
    /** Resolution type */
    type: ResolutionType;
}

/**
 * Resolution type enumeration.
 */
export enum ResolutionType {
    ACCEPTED = 'accepted',
    REJECTED = 'rejected',
    IMPLEMENTED = 'implemented',
    DUPLICATE = 'duplicate',
    INVALID = 'invalid',
    WONT_FIX = 'wont_fix'
}

/**
 * Comment edit history entry.
 */
export interface ICommentEdit {
    /** User who made the edit */
    editedBy: string;
    
    /** Edit timestamp */
    editedAt: Date;
    
    /** Edit type (content, metadata, status) */
    editType: CommentEditType;
    
    /** Previous content/state */
    previousValue?: JSONValue;
    
    /** Edit reason or description */
    reason?: string;
}

/**
 * Comment edit type enumeration.
 */
export enum CommentEditType {
    CONTENT = 'content',
    METADATA = 'metadata',
    STATUS = 'status',
    ANCHOR = 'anchor',
    TAGS = 'tags'
}

/**
 * Comment timestamps for lifecycle tracking.
 */
export interface ICommentTimestamps {
    /** Comment creation timestamp */
    createdAt: Date;
    
    /** Last modification timestamp */
    updatedAt: Date;
    
    /** Last activity timestamp (reply, edit, reaction) */
    lastActivityAt: Date;
    
    /** Scheduled deletion timestamp (for soft deletes) */
    scheduledDeletionAt?: Date;
}

/**
 * Comment visibility and access control.
 */
export interface ICommentVisibility {
    /** Visibility scope (public, private, team, role) */
    scope: VisibilityScope;
    
    /** Specific users with access */
    allowedUsers: string[];
    
    /** Specific roles with access */
    allowedRoles: UserRole[];
    
    /** Access permissions */
    permissions: ICommentPermissions;
}

/**
 * Visibility scope enumeration.
 */
export enum VisibilityScope {
    PUBLIC = 'public',
    PRIVATE = 'private',
    TEAM = 'team',
    ROLE_BASED = 'role',
    CUSTOM = 'custom'
}

/**
 * Comment-specific permissions.
 */
export interface ICommentPermissions {
    /** Can view the comment */
    canView: boolean;
    
    /** Can reply to the comment */
    canReply: boolean;
    
    /** Can edit the comment */
    canEdit: boolean;
    
    /** Can delete the comment */
    canDelete: boolean;
    
    /** Can resolve the comment */
    canResolve: boolean;
    
    /** Can moderate the comment thread */
    canModerate: boolean;
}

/**
 * Comment attachment information.
 */
export interface ICommentAttachment {
    /** Attachment ID */
    attachmentId: string;
    
    /** Attachment type */
    type: AttachmentType;
    
    /** File name */
    fileName: string;
    
    /** File size in bytes */
    fileSize: number;
    
    /** MIME type */
    mimeType: string;
    
    /** Storage URL or path */
    url: string;
    
    /** Attachment metadata */
    metadata: JSONObject;
    
    /** Upload timestamp */
    uploadedAt: Date;
}

/**
 * Attachment type enumeration.
 */
export enum AttachmentType {
    IMAGE = 'image',
    DOCUMENT = 'document',
    NOTEBOOK = 'notebook',
    DATA_FILE = 'data',
    SCREENSHOT = 'screenshot',
    LINK = 'link'
}

/**
 * Comment thread aggregation.
 */
export interface ICommentThread {
    /** Thread root comment ID */
    threadId: string;
    
    /** All comments in the thread (sorted by creation time) */
    comments: IComment[];
    
    /** Thread metadata */
    metadata: IThreadMetadata;
    
    /** Thread participants */
    participants: ICommentAuthor[];
    
    /** Thread statistics */
    statistics: IThreadStatistics;
}

/**
 * Thread metadata.
 */
export interface IThreadMetadata {
    /** Thread creation timestamp */
    createdAt: Date;
    
    /** Last activity timestamp */
    lastActivityAt: Date;
    
    /** Thread creator */
    createdBy: string;
    
    /** Thread status */
    status: ThreadStatus;
    
    /** Thread tags */
    tags: string[];
    
    /** Thread priority (highest comment priority in thread) */
    priority: CommentPriority;
}

/**
 * Thread status enumeration.
 */
export enum ThreadStatus {
    ACTIVE = 'active',
    RESOLVED = 'resolved',
    ARCHIVED = 'archived',
    LOCKED = 'locked'
}

/**
 * Thread statistics.
 */
export interface IThreadStatistics {
    /** Total comment count */
    commentCount: number;
    
    /** Participant count */
    participantCount: number;
    
    /** Unresolved comment count */
    unresolvedCount: number;
    
    /** Thread depth (maximum nesting level) */
    maxDepth: number;
    
    /** Average response time */
    averageResponseTime: number;
}

/**
 * Comment notification configuration.
 */
export interface ICommentNotification {
    /** Notification ID */
    notificationId: string;
    
    /** Target user ID */
    userId: string;
    
    /** Notification type */
    type: NotificationType;
    
    /** Related comment or thread ID */
    relatedId: string;
    
    /** Notification content */
    content: INotificationContent;
    
    /** Notification status */
    status: NotificationStatus;
    
    /** Delivery channels */
    channels: NotificationChannel[];
    
    /** Timestamps */
    timestamps: INotificationTimestamps;
    
    /** Notification metadata */
    metadata: JSONObject;
}

/**
 * Notification type enumeration.
 */
export enum NotificationType {
    COMMENT_CREATED = 'comment_created',
    COMMENT_REPLY = 'comment_reply',
    COMMENT_EDITED = 'comment_edited',
    COMMENT_RESOLVED = 'comment_resolved',
    COMMENT_MENTIONED = 'comment_mentioned',
    THREAD_ASSIGNED = 'thread_assigned',
    THREAD_LOCKED = 'thread_locked',
    DAILY_DIGEST = 'daily_digest'
}

/**
 * Notification content.
 */
export interface INotificationContent {
    /** Notification title */
    title: string;
    
    /** Notification message */
    message: string;
    
    /** Rich content for HTML notifications */
    richContent?: string;
    
    /** Action buttons or links */
    actions: INotificationAction[];
    
    /** Context information */
    context: JSONObject;
}

/**
 * Notification action.
 */
export interface INotificationAction {
    /** Action ID */
    actionId: string;
    
    /** Action label */
    label: string;
    
    /** Action URL or command */
    target: string;
    
    /** Action type */
    type: NotificationActionType;
    
    /** Action style/appearance */
    style: ActionStyle;
}

/**
 * Notification action type enumeration.
 */
export enum NotificationActionType {
    URL = 'url',
    COMMAND = 'command',
    REPLY = 'reply',
    RESOLVE = 'resolve',
    DISMISS = 'dismiss'
}

/**
 * Action style enumeration.
 */
export enum ActionStyle {
    PRIMARY = 'primary',
    SECONDARY = 'secondary',
    SUCCESS = 'success',
    WARNING = 'warning',
    DANGER = 'danger'
}

/**
 * Notification status enumeration.
 */
export enum NotificationStatus {
    PENDING = 'pending',
    SENT = 'sent',
    DELIVERED = 'delivered',
    READ = 'read',
    DISMISSED = 'dismissed',
    FAILED = 'failed'
}

/**
 * Notification delivery channel enumeration.
 */
export enum NotificationChannel {
    IN_APP = 'in_app',
    EMAIL = 'email',
    WEBSOCKET = 'websocket',
    PUSH = 'push',
    SLACK = 'slack',
    TEAMS = 'teams'
}

/**
 * Notification timestamps.
 */
export interface INotificationTimestamps {
    /** Created timestamp */
    createdAt: Date;
    
    /** Scheduled delivery timestamp */
    scheduledAt: Date;
    
    /** Actual delivery timestamp */
    deliveredAt?: Date;
    
    /** Read timestamp */
    readAt?: Date;
    
    /** Dismissal timestamp */
    dismissedAt?: Date;
}

/**
 * Comment search query interface.
 */
export interface ICommentSearchQuery {
    /** Text search terms */
    text?: string;
    
    /** Author filter */
    author?: string;
    
    /** Date range filter */
    dateRange?: IDateRange;
    
    /** Status filter */
    status?: CommentStatus[];
    
    /** Priority filter */
    priority?: CommentPriority[];
    
    /** Type filter */
    type?: CommentType[];
    
    /** Tag filter */
    tags?: string[];
    
    /** Cell ID filter */
    cellId?: string;
    
    /** Thread ID filter */
    threadId?: string;
    
    /** Search scope */
    scope?: SearchScope;
    
    /** Sort criteria */
    sort?: ISortCriteria;
    
    /** Pagination */
    pagination?: IPagination;
}

/**
 * Date range filter.
 */
export interface IDateRange {
    /** Start date */
    start: Date;
    
    /** End date */
    end: Date;
}

/**
 * Search scope enumeration.
 */
export enum SearchScope {
    ALL_COMMENTS = 'all',
    MY_COMMENTS = 'my',
    MENTIONS = 'mentions',
    ASSIGNED = 'assigned',
    UNRESOLVED = 'unresolved'
}

/**
 * Sort criteria.
 */
export interface ISortCriteria {
    /** Sort field */
    field: SortField;
    
    /** Sort direction */
    direction: SortDirection;
}

/**
 * Sort field enumeration.
 */
export enum SortField {
    CREATED_AT = 'createdAt',
    UPDATED_AT = 'updatedAt',
    LAST_ACTIVITY = 'lastActivityAt',
    AUTHOR = 'author',
    PRIORITY = 'priority',
    STATUS = 'status',
    RELEVANCE = 'relevance'
}

/**
 * Sort direction enumeration.
 */
export enum SortDirection {
    ASC = 'asc',
    DESC = 'desc'
}

/**
 * Pagination parameters.
 */
export interface IPagination {
    /** Page number (0-based) */
    page: number;
    
    /** Results per page */
    pageSize: number;
    
    /** Total result count */
    totalCount?: number;
    
    /** Maximum results to return */
    maxResults?: number;
}

/**
 * Comment search results.
 */
export interface ICommentSearchResults {
    /** Matching comments */
    comments: IComment[];
    
    /** Total match count */
    totalCount: number;
    
    /** Search execution time */
    executionTime: number;
    
    /** Faceted results */
    facets: ISearchFacets;
    
    /** Search metadata */
    metadata: JSONObject;
}

/**
 * Search result facets.
 */
export interface ISearchFacets {
    /** Author facets */
    authors: IFacet[];
    
    /** Status facets */
    statuses: IFacet[];
    
    /** Priority facets */
    priorities: IFacet[];
    
    /** Type facets */
    types: IFacet[];
    
    /** Tag facets */
    tags: IFacet[];
    
    /** Date range facets */
    dateRanges: IFacet[];
}

/**
 * Search facet.
 */
export interface IFacet {
    /** Facet value */
    value: string;
    
    /** Result count for this facet */
    count: number;
    
    /** Facet display label */
    label: string;
}

/**
 * Comments system configuration.
 */
export interface ICommentsConfig {
    /** MongoDB connection configuration */
    mongodb: IMongoDbConfig;
    
    /** WebSocket configuration */
    websocket: IWebSocketConfig;
    
    /** Notification configuration */
    notifications: INotificationConfig;
    
    /** Search configuration */
    search: ISearchConfig;
    
    /** Storage configuration */
    storage: IStorageConfig;
    
    /** Security configuration */
    security: ISecurityConfig;
    
    /** Feature flags */
    features: IFeatureFlags;
    
    /** Performance settings */
    performance: IPerformanceConfig;
}

/**
 * MongoDB configuration.
 */
export interface IMongoDbConfig {
    /** Connection URL */
    connectionUrl: string;
    
    /** Database name */
    databaseName: string;
    
    /** Collection names */
    collections: IMongoCollections;
    
    /** Connection options */
    options: IMongoOptions;
    
    /** Indexing configuration */
    indexes: IMongoIndexes;
}

/**
 * MongoDB collection names.
 */
export interface IMongoCollections {
    /** Comments collection */
    comments: string;
    
    /** Threads collection */
    threads: string;
    
    /** Notifications collection */
    notifications: string;
    
    /** Attachments collection */
    attachments: string;
    
    /** User preferences collection */
    userPreferences: string;
}

/**
 * MongoDB connection options.
 */
export interface IMongoOptions {
    /** Connection pool size */
    maxPoolSize: number;
    
    /** Connection timeout */
    connectTimeoutMS: number;
    
    /** Socket timeout */
    socketTimeoutMS: number;
    
    /** Server selection timeout */
    serverSelectionTimeoutMS: number;
    
    /** Enable SSL */
    ssl: boolean;
    
    /** SSL certificate options */
    sslOptions?: JSONObject;
}

/**
 * MongoDB index configuration.
 */
export interface IMongoIndexes {
    /** Enable text search indexes */
    textSearch: boolean;
    
    /** Enable compound indexes */
    compoundIndexes: boolean;
    
    /** TTL index settings */
    ttlIndexes: ITTLIndexConfig[];
    
    /** Custom indexes */
    customIndexes: ICustomIndex[];
}

/**
 * TTL index configuration.
 */
export interface ITTLIndexConfig {
    /** Collection name */
    collection: string;
    
    /** Field name */
    field: string;
    
    /** TTL in seconds */
    expireAfterSeconds: number;
}

/**
 * Custom index configuration.
 */
export interface ICustomIndex {
    /** Collection name */
    collection: string;
    
    /** Index specification */
    spec: JSONObject;
    
    /** Index options */
    options?: JSONObject;
}

/**
 * WebSocket configuration.
 */
export interface IWebSocketConfig {
    /** WebSocket endpoint URL */
    endpoint: string;
    
    /** Channel name for comments */
    channel: string;
    
    /** Message types */
    messageTypes: IWebSocketMessageTypes;
    
    /** Connection options */
    options: IWebSocketOptions;
}

/**
 * WebSocket message types.
 */
export interface IWebSocketMessageTypes {
    /** Comment created */
    commentCreated: string;
    
    /** Comment updated */
    commentUpdated: string;
    
    /** Comment deleted */
    commentDeleted: string;
    
    /** Comment resolved */
    commentResolved: string;
    
    /** Thread status changed */
    threadStatusChanged: string;
}

/**
 * WebSocket connection options.
 */
export interface IWebSocketOptions {
    /** Reconnection enabled */
    reconnection: boolean;
    
    /** Reconnection attempts */
    reconnectionAttempts: number;
    
    /** Reconnection delay */
    reconnectionDelay: number;
    
    /** Message acknowledgment timeout */
    ackTimeout: number;
}

/**
 * Notification configuration.
 */
export interface INotificationConfig {
    /** Enable notifications */
    enabled: boolean;
    
    /** Available channels */
    channels: NotificationChannel[];
    
    /** Default notification preferences */
    defaultPreferences: INotificationPreferences;
    
    /** Channel configurations */
    channelConfigs: IChannelConfigs;
    
    /** Digest settings */
    digest: IDigestConfig;
}

/**
 * Notification preferences.
 */
export interface INotificationPreferences {
    /** Notification types to enable */
    enabledTypes: NotificationType[];
    
    /** Preferred channels by type */
    channelPreferences: Map<NotificationType, NotificationChannel[]>;
    
    /** Digest frequency */
    digestFrequency: DigestFrequency;
    
    /** Quiet hours */
    quietHours: IQuietHours;
}

/**
 * Digest frequency enumeration.
 */
export enum DigestFrequency {
    IMMEDIATE = 'immediate',
    HOURLY = 'hourly',
    DAILY = 'daily',
    WEEKLY = 'weekly',
    DISABLED = 'disabled'
}

/**
 * Quiet hours configuration.
 */
export interface IQuietHours {
    /** Enable quiet hours */
    enabled: boolean;
    
    /** Start time (24-hour format) */
    startTime: string;
    
    /** End time (24-hour format) */
    endTime: string;
    
    /** Timezone */
    timezone: string;
    
    /** Days of week (0=Sunday) */
    daysOfWeek: number[];
}

/**
 * Channel configurations.
 */
export interface IChannelConfigs {
    /** Email configuration */
    email?: IEmailConfig;
    
    /** Slack configuration */
    slack?: ISlackConfig;
    
    /** Teams configuration */
    teams?: ITeamsConfig;
    
    /** Push notification configuration */
    push?: IPushConfig;
}

/**
 * Email configuration.
 */
export interface IEmailConfig {
    /** SMTP server */
    smtpServer: string;
    
    /** SMTP port */
    smtpPort: number;
    
    /** Enable SSL */
    ssl: boolean;
    
    /** Authentication */
    auth: IEmailAuth;
    
    /** Email templates */
    templates: IEmailTemplates;
}

/**
 * Email authentication.
 */
export interface IEmailAuth {
    /** Username */
    username: string;
    
    /** Password */
    password: string;
}

/**
 * Email templates.
 */
export interface IEmailTemplates {
    /** Comment notification template */
    commentNotification: string;
    
    /** Digest template */
    digest: string;
    
    /** Mention template */
    mention: string;
}

/**
 * Slack configuration.
 */
export interface ISlackConfig {
    /** Slack API token */
    token: string;
    
    /** Default channel */
    defaultChannel: string;
    
    /** Message templates */
    templates: ISlackTemplates;
}

/**
 * Slack templates.
 */
export interface ISlackTemplates {
    /** Comment notification template */
    commentNotification: string;
    
    /** Mention template */
    mention: string;
}

/**
 * Teams configuration.
 */
export interface ITeamsConfig {
    /** Webhook URL */
    webhookUrl: string;
    
    /** Message templates */
    templates: ITeamsTemplates;
}

/**
 * Teams templates.
 */
export interface ITeamsTemplates {
    /** Comment notification template */
    commentNotification: string;
}

/**
 * Push notification configuration.
 */
export interface IPushConfig {
    /** Service provider */
    provider: PushProvider;
    
    /** Provider configuration */
    config: JSONObject;
}

/**
 * Push notification provider enumeration.
 */
export enum PushProvider {
    FCM = 'fcm',
    APNS = 'apns',
    WNS = 'wns'
}

/**
 * Digest configuration.
 */
export interface IDigestConfig {
    /** Enable digest */
    enabled: boolean;
    
    /** Default frequency */
    defaultFrequency: DigestFrequency;
    
    /** Maximum items per digest */
    maxItems: number;
    
    /** Digest template */
    template: string;
}

/**
 * Search configuration.
 */
export interface ISearchConfig {
    /** Enable full-text search */
    fullTextSearch: boolean;
    
    /** Search provider */
    provider: SearchProvider;
    
    /** Index settings */
    indexSettings: IIndexSettings;
    
    /** Search limits */
    limits: ISearchLimits;
}

/**
 * Search provider enumeration.
 */
export enum SearchProvider {
    MONGODB = 'mongodb',
    ELASTICSEARCH = 'elasticsearch',
    SOLR = 'solr'
}

/**
 * Index settings.
 */
export interface IIndexSettings {
    /** Language for text analysis */
    language: string;
    
    /** Stop words */
    stopWords: string[];
    
    /** Stemming enabled */
    stemming: boolean;
    
    /** Synonyms */
    synonyms: string[][];
}

/**
 * Search limits.
 */
export interface ISearchLimits {
    /** Maximum results per query */
    maxResults: number;
    
    /** Maximum query length */
    maxQueryLength: number;
    
    /** Query timeout */
    queryTimeout: number;
}

/**
 * Storage configuration.
 */
export interface IStorageConfig {
    /** Attachment storage provider */
    attachmentProvider: StorageProvider;
    
    /** Storage limits */
    limits: IStorageLimits;
    
    /** Cleanup policies */
    cleanup: ICleanupConfig;
}

/**
 * Storage provider enumeration.
 */
export enum StorageProvider {
    LOCAL = 'local',
    S3 = 's3',
    GCS = 'gcs',
    AZURE = 'azure'
}

/**
 * Storage limits.
 */
export interface IStorageLimits {
    /** Maximum attachment size */
    maxAttachmentSize: number;
    
    /** Maximum attachments per comment */
    maxAttachmentsPerComment: number;
    
    /** Maximum total storage per user */
    maxStoragePerUser: number;
}

/**
 * Cleanup configuration.
 */
export interface ICleanupConfig {
    /** Enable automatic cleanup */
    enabled: boolean;
    
    /** Retention period for deleted comments */
    deletedCommentRetention: number;
    
    /** Retention period for archived threads */
    archivedThreadRetention: number;
    
    /** Cleanup frequency */
    cleanupFrequency: CleanupFrequency;
}

/**
 * Cleanup frequency enumeration.
 */
export enum CleanupFrequency {
    HOURLY = 'hourly',
    DAILY = 'daily',
    WEEKLY = 'weekly',
    MONTHLY = 'monthly'
}

/**
 * Security configuration.
 */
export interface ISecurityConfig {
    /** Content sanitization */
    sanitization: ISanitizationConfig;
    
    /** Rate limiting */
    rateLimiting: IRateLimitConfig;
    
    /** Spam detection */
    spamDetection: ISpamDetectionConfig;
}

/**
 * Content sanitization configuration.
 */
export interface ISanitizationConfig {
    /** Enable HTML sanitization */
    enabled: boolean;
    
    /** Allowed HTML tags */
    allowedTags: string[];
    
    /** Allowed attributes */
    allowedAttributes: string[];
    
    /** Allowed URL schemes */
    allowedSchemes: string[];
}

/**
 * Rate limiting configuration.
 */
export interface IRateLimitConfig {
    /** Enable rate limiting */
    enabled: boolean;
    
    /** Comments per minute */
    commentsPerMinute: number;
    
    /** Comments per hour */
    commentsPerHour: number;
    
    /** Burst limit */
    burstLimit: number;
}

/**
 * Spam detection configuration.
 */
export interface ISpamDetectionConfig {
    /** Enable spam detection */
    enabled: boolean;
    
    /** Spam detection provider */
    provider: SpamProvider;
    
    /** Detection thresholds */
    thresholds: ISpamThresholds;
}

/**
 * Spam detection provider enumeration.
 */
export enum SpamProvider {
    AKISMET = 'akismet',
    RECAPTCHA = 'recaptcha',
    CUSTOM = 'custom'
}

/**
 * Spam detection thresholds.
 */
export interface ISpamThresholds {
    /** Spam confidence threshold */
    confidenceThreshold: number;
    
    /** Auto-delete threshold */
    autoDeleteThreshold: number;
    
    /** Quarantine threshold */
    quarantineThreshold: number;
}

/**
 * Feature flags configuration.
 */
export interface IFeatureFlags {
    /** Enable threaded comments */
    threadedComments: boolean;
    
    /** Enable comment attachments */
    attachments: boolean;
    
    /** Enable mentions */
    mentions: boolean;
    
    /** Enable rich text editing */
    richTextEditing: boolean;
    
    /** Enable comment reactions */
    reactions: boolean;
    
    /** Enable comment templates */
    templates: boolean;
    
    /** Enable AI-powered features */
    aiFeatures: boolean;
}

/**
 * Performance configuration.
 */
export interface IPerformanceConfig {
    /** Cache settings */
    cache: ICacheConfig;
    
    /** Connection pooling */
    connectionPooling: IConnectionPoolConfig;
    
    /** Batch processing */
    batchProcessing: IBatchConfig;
}

/**
 * Cache configuration.
 */
export interface ICacheConfig {
    /** Enable caching */
    enabled: boolean;
    
    /** Cache provider */
    provider: CacheProvider;
    
    /** Cache TTL */
    ttl: number;
    
    /** Maximum cache size */
    maxSize: number;
}

/**
 * Cache provider enumeration.
 */
export enum CacheProvider {
    MEMORY = 'memory',
    REDIS = 'redis',
    MEMCACHED = 'memcached'
}

/**
 * Connection pool configuration.
 */
export interface IConnectionPoolConfig {
    /** Minimum connections */
    minConnections: number;
    
    /** Maximum connections */
    maxConnections: number;
    
    /** Connection timeout */
    connectionTimeout: number;
    
    /** Idle timeout */
    idleTimeout: number;
}

/**
 * Batch processing configuration.
 */
export interface IBatchConfig {
    /** Enable batch processing */
    enabled: boolean;
    
    /** Batch size */
    batchSize: number;
    
    /** Batch timeout */
    batchTimeout: number;
    
    /** Maximum concurrent batches */
    maxConcurrentBatches: number;
}

/**
 * Comments system event types.
 */
export enum CommentsEventType {
    COMMENT_CREATED = 'comment-created',
    COMMENT_UPDATED = 'comment-updated',
    COMMENT_DELETED = 'comment-deleted',
    COMMENT_RESOLVED = 'comment-resolved',
    THREAD_CREATED = 'thread-created',
    THREAD_UPDATED = 'thread-updated',
    THREAD_LOCKED = 'thread-locked',
    NOTIFICATION_SENT = 'notification-sent',
    SEARCH_PERFORMED = 'search-performed',
    ERROR_OCCURRED = 'error-occurred'
}

/**
 * Comments system event data.
 */
export interface ICommentsEvent {
    /** Event type */
    type: CommentsEventType;
    
    /** Event data */
    data: JSONValue;
    
    /** Event timestamp */
    timestamp: number;
    
    /** User ID */
    userId?: string;
    
    /** Session ID */
    sessionId?: string;
    
    /** Document ID */
    documentId?: string;
}

/**
 * Default comments system configuration.
 */
export const DEFAULT_COMMENTS_CONFIG: Partial<ICommentsConfig> = {
    mongodb: {
        connectionUrl: process.env.JUPYTER_COLLAB_MONGODB_URL || 'mongodb://localhost:27017',
        databaseName: 'jupyter_collaboration',
        collections: {
            comments: 'comments',
            threads: 'comment_threads',
            notifications: 'comment_notifications',
            attachments: 'comment_attachments',
            userPreferences: 'comment_user_preferences'
        },
        options: {
            maxPoolSize: 10,
            connectTimeoutMS: 30000,
            socketTimeoutMS: 45000,
            serverSelectionTimeoutMS: 5000,
            ssl: false
        },
        indexes: {
            textSearch: true,
            compoundIndexes: true,
            ttlIndexes: [
                {
                    collection: 'comment_notifications',
                    field: 'createdAt',
                    expireAfterSeconds: 2592000 // 30 days
                }
            ],
            customIndexes: []
        }
    },
    websocket: {
        endpoint: '/collaboration/comments',
        channel: 'comments',
        messageTypes: {
            commentCreated: 'comment:created',
            commentUpdated: 'comment:updated',
            commentDeleted: 'comment:deleted',
            commentResolved: 'comment:resolved',
            threadStatusChanged: 'thread:status_changed'
        },
        options: {
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            ackTimeout: 10000
        }
    },
    notifications: {
        enabled: true,
        channels: [NotificationChannel.IN_APP, NotificationChannel.WEBSOCKET],
        defaultPreferences: {
            enabledTypes: [
                NotificationType.COMMENT_REPLY,
                NotificationType.COMMENT_MENTIONED,
                NotificationType.COMMENT_RESOLVED
            ],
            channelPreferences: new Map(),
            digestFrequency: DigestFrequency.DAILY,
            quietHours: {
                enabled: false,
                startTime: '22:00',
                endTime: '08:00',
                timezone: 'UTC',
                daysOfWeek: [0, 1, 2, 3, 4, 5, 6]
            }
        },
        channelConfigs: {},
        digest: {
            enabled: true,
            defaultFrequency: DigestFrequency.DAILY,
            maxItems: 50,
            template: 'default'
        }
    },
    search: {
        fullTextSearch: true,
        provider: SearchProvider.MONGODB,
        indexSettings: {
            language: 'english',
            stopWords: ['the', 'a', 'an', 'and', 'or', 'but'],
            stemming: true,
            synonyms: []
        },
        limits: {
            maxResults: 1000,
            maxQueryLength: 1000,
            queryTimeout: 30000
        }
    },
    storage: {
        attachmentProvider: StorageProvider.LOCAL,
        limits: {
            maxAttachmentSize: 10 * 1024 * 1024, // 10MB
            maxAttachmentsPerComment: 5,
            maxStoragePerUser: 100 * 1024 * 1024 // 100MB
        },
        cleanup: {
            enabled: true,
            deletedCommentRetention: 2592000, // 30 days
            archivedThreadRetention: 31536000, // 1 year
            cleanupFrequency: CleanupFrequency.DAILY
        }
    },
    security: {
        sanitization: {
            enabled: true,
            allowedTags: ['p', 'br', 'strong', 'em', 'u', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li'],
            allowedAttributes: ['class', 'id'],
            allowedSchemes: ['http', 'https', 'mailto']
        },
        rateLimiting: {
            enabled: true,
            commentsPerMinute: 10,
            commentsPerHour: 100,
            burstLimit: 5
        },
        spamDetection: {
            enabled: false,
            provider: SpamProvider.CUSTOM,
            thresholds: {
                confidenceThreshold: 0.8,
                autoDeleteThreshold: 0.95,
                quarantineThreshold: 0.9
            }
        }
    },
    features: {
        threadedComments: true,
        attachments: true,
        mentions: true,
        richTextEditing: true,
        reactions: false,
        templates: false,
        aiFeatures: false
    },
    performance: {
        cache: {
            enabled: true,
            provider: CacheProvider.MEMORY,
            ttl: 300, // 5 minutes
            maxSize: 1000
        },
        connectionPooling: {
            minConnections: 2,
            maxConnections: 10,
            connectionTimeout: 30000,
            idleTimeout: 300000
        },
        batchProcessing: {
            enabled: true,
            batchSize: 100,
            batchTimeout: 5000,
            maxConcurrentBatches: 3
        }
    }
};

/**
 * Main Comments System class for collaborative notebook commenting.
 * 
 * This class provides comprehensive comment and review capabilities for collaborative
 * Jupyter Notebook editing. It manages comment lifecycle, real-time synchronization,
 * notification workflows, and search functionality.
 * 
 * Key Responsibilities:
 * - Comment CRUD operations with MongoDB persistence
 * - Real-time comment synchronization via WebSocket
 * - Threaded discussion management
 * - User notification system
 * - Comment search and filtering
 * - Integration with collaborative editing infrastructure
 * - Security and spam protection
 * - Performance optimization and caching
 */
export class CommentsSystem implements IObservableDisposable {
    private readonly _config: ICommentsConfig;
    private readonly _documentId: string;
    private readonly _sessionId: string;
    private readonly _collaborationProvider: ICollaborationProvider;
    private readonly _awareness: CollaborativeAwareness;
    
    // MongoDB connection and collections
    private _mongoClient: any = null;
    private _database: any = null;
    private _collections: any = {};
    
    // WebSocket for real-time communication
    private _websocket: WebSocket | null = null;
    private _websocketReconnectTimer: NodeJS.Timeout | null = null;
    
    // Cache for performance optimization
    private _commentCache: Map<string, IComment> = new Map();
    private _threadCache: Map<string, ICommentThread> = new Map();
    private _userPreferencesCache: Map<string, INotificationPreferences> = new Map();
    
    // State management
    private _isInitialized = false;
    private _isDisposed = false;
    private _pendingOperations: Map<string, Promise<any>> = new Map();
    private _currentUser: ICommentAuthor | null = null;
    
    // Performance tracking
    private _metrics: Map<string, number> = new Map();
    private _lastCleanupTime = 0;
    
    // Event signals
    private readonly _disposed = new Signal<this, void>(this);
    private readonly _commentCreated = new Signal<this, ICommentsEvent>(this);
    private readonly _commentUpdated = new Signal<this, ICommentsEvent>(this);
    private readonly _commentDeleted = new Signal<this, ICommentsEvent>(this);
    private readonly _commentResolved = new Signal<this, ICommentsEvent>(this);
    private readonly _threadCreated = new Signal<this, ICommentsEvent>(this);
    private readonly _threadUpdated = new Signal<this, ICommentsEvent>(this);
    private readonly _notificationSent = new Signal<this, ICommentsEvent>(this);
    private readonly _errorOccurred = new Signal<this, Error>(this);

    /**
     * Create a new CommentsSystem instance.
     * 
     * @param config - Comments system configuration
     * @param documentId - Unique document identifier
     * @param sessionId - Collaborative session identifier
     * @param collaborationProvider - Provider for collaboration integration
     * @param awareness - Awareness system for user presence
     */
    constructor(
        config: Partial<ICommentsConfig>,
        documentId: string,
        sessionId: string,
        collaborationProvider: ICollaborationProvider,
        awareness: CollaborativeAwareness
    ) {
        // Validate required parameters
        if (!documentId || !sessionId) {
            throw new Error('CommentsSystem requires documentId and sessionId');
        }

        this._config = this._mergeConfig(config);
        this._documentId = documentId;
        this._sessionId = sessionId;
        this._collaborationProvider = collaborationProvider;
        this._awareness = awareness;

        // Set up current user from awareness
        this._setupCurrentUser();

        // Set up collaboration provider event listeners
        this._setupCollaborationListeners();

        console.log(`[CommentsSystem] Created for document ${documentId} in session ${sessionId}`);
    }

    /**
     * Get the document identifier.
     */
    get documentId(): string {
        return this._documentId;
    }

    /**
     * Get the session identifier.
     */
    get sessionId(): string {
        return this._sessionId;
    }

    /**
     * Get the current user.
     */
    get currentUser(): ICommentAuthor | null {
        return this._currentUser;
    }

    /**
     * Check if the system has been disposed.
     */
    get isDisposed(): boolean {
        return this._isDisposed;
    }

    /**
     * Signal emitted when the system is disposed.
     */
    get disposed(): ISignal<this, void> {
        return this._disposed;
    }

    /**
     * Signal emitted when a comment is created.
     */
    get commentCreated(): ISignal<this, ICommentsEvent> {
        return this._commentCreated;
    }

    /**
     * Signal emitted when a comment is updated.
     */
    get commentUpdated(): ISignal<this, ICommentsEvent> {
        return this._commentUpdated;
    }

    /**
     * Signal emitted when a comment is deleted.
     */
    get commentDeleted(): ISignal<this, ICommentsEvent> {
        return this._commentDeleted;
    }

    /**
     * Signal emitted when a comment is resolved.
     */
    get commentResolved(): ISignal<this, ICommentsEvent> {
        return this._commentResolved;
    }

    /**
     * Signal emitted when a thread is created.
     */
    get threadCreated(): ISignal<this, ICommentsEvent> {
        return this._threadCreated;
    }

    /**
     * Signal emitted when a thread is updated.
     */
    get threadUpdated(): ISignal<this, ICommentsEvent> {
        return this._threadUpdated;
    }

    /**
     * Signal emitted when a notification is sent.
     */
    get notificationSent(): ISignal<this, ICommentsEvent> {
        return this._notificationSent;
    }

    /**
     * Signal emitted when an error occurs.
     */
    get errorOccurred(): ISignal<this, Error> {
        return this._errorOccurred;
    }

    /**
     * Initialize the comments system.
     * 
     * @returns Promise that resolves when initialization is complete
     */
    async initialize(): Promise<void> {
        if (this._isDisposed) {
            throw new Error('Cannot initialize disposed CommentsSystem');
        }

        if (this._isInitialized) {
            console.warn('[CommentsSystem] System already initialized');
            return;
        }

        try {
            console.log('[CommentsSystem] Initializing comments system...');

            // Initialize MongoDB connection
            await this._initializeMongoDB();

            // Initialize WebSocket connection
            await this._initializeWebSocket();

            // Set up indexes and collections
            await this._setupCollections();

            // Set up performance monitoring
            this._setupPerformanceMonitoring();

            // Set up cleanup routines
            this._setupCleanupRoutines();

            this._isInitialized = true;

            console.log('[CommentsSystem] Comments system initialized successfully');

        } catch (error) {
            const initError = new Error(`Failed to initialize CommentsSystem: ${error.message}`);
            this._emitError(initError);
            throw initError;
        }
    }

    /**
     * Create a new comment.
     * 
     * @param content - Comment content
     * @param anchor - Comment anchor information
     * @param options - Additional comment options
     * @returns Promise that resolves to the created comment
     */
    async createComment(
        content: ICommentContent,
        anchor: ICommentAnchor,
        options: Partial<{
            parentId: string;
            type: CommentType;
            priority: CommentPriority;
            tags: string[];
            visibility: ICommentVisibility;
            attachments: ICommentAttachment[];
        }> = {}
    ): Promise<IComment> {
        this._ensureInitialized();

        // Validate input
        if (!content.text?.trim()) {
            throw new Error('Comment content cannot be empty');
        }

        if (!anchor.cellId) {
            throw new Error('Comment anchor must specify a cell ID');
        }

        if (!this._currentUser) {
            throw new Error('No current user available for comment creation');
        }

        try {
            const startTime = performance.now();

            // Generate IDs
            const commentId = UUID.uuid4();
            const threadId = options.parentId ? await this._getThreadId(options.parentId) : commentId;

            // Create comment object
            const comment: IComment = {
                commentId,
                parentId: options.parentId || null,
                threadId,
                content: this._sanitizeContent(content),
                author: { ...this._currentUser },
                anchor: this._validateAnchor(anchor),
                metadata: {
                    status: CommentStatus.ACTIVE,
                    priority: options.priority || CommentPriority.NORMAL,
                    type: options.type || CommentType.ANNOTATION,
                    custom: {},
                    version: 1
                },
                timestamps: {
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    lastActivityAt: new Date()
                },
                visibility: options.visibility || this._getDefaultVisibility(),
                tags: options.tags || [],
                attachments: options.attachments || []
            };

            // Apply rate limiting
            await this._checkRateLimit(this._currentUser.userId);

            // Persist to MongoDB
            await this._saveComment(comment);

            // Update thread metadata
            await this._updateThreadMetadata(threadId);

            // Cache the comment
            this._commentCache.set(commentId, comment);

            // Broadcast via WebSocket
            await this._broadcastCommentChange('created', comment);

            // Send notifications
            await this._sendCommentNotifications(comment, 'created');

            // Track metrics
            const latency = performance.now() - startTime;
            this._trackMetric('comment_create_latency', latency);
            this._trackMetric('comments_created', 1);

            // Emit event
            this._emitCommentCreated(comment);

            console.log(`[CommentsSystem] Created comment ${commentId} in thread ${threadId} (${latency.toFixed(2)}ms)`);

            return comment;

        } catch (error) {
            const createError = new Error(`Failed to create comment: ${error.message}`);
            this._emitError(createError);
            throw createError;
        }
    }

    /**
     * Update an existing comment.
     * 
     * @param commentId - Comment ID to update
     * @param updates - Comment updates
     * @returns Promise that resolves to the updated comment
     */
    async updateComment(
        commentId: string,
        updates: Partial<{
            content: ICommentContent;
            anchor: ICommentAnchor;
            metadata: Partial<ICommentMetadata>;
            tags: string[];
            visibility: ICommentVisibility;
        }>
    ): Promise<IComment> {
        this._ensureInitialized();

        if (!commentId) {
            throw new Error('Comment ID is required for update');
        }

        try {
            const startTime = performance.now();

            // Get existing comment
            const existingComment = await this.getComment(commentId);
            if (!existingComment) {
                throw new Error(`Comment ${commentId} not found`);
            }

            // Check permissions
            if (!this._canEditComment(existingComment)) {
                throw new Error('Insufficient permissions to edit comment');
            }

            // Create updated comment
            const updatedComment: IComment = {
                ...existingComment,
                ...updates,
                metadata: {
                    ...existingComment.metadata,
                    ...updates.metadata,
                    version: existingComment.metadata.version + 1,
                    lastEdit: {
                        editedBy: this._currentUser!.userId,
                        editedAt: new Date(),
                        editType: this._determineEditType(updates),
                        previousValue: this._extractPreviousValue(existingComment, updates)
                    }
                },
                timestamps: {
                    ...existingComment.timestamps,
                    updatedAt: new Date(),
                    lastActivityAt: new Date()
                }
            };

            // Sanitize content if updated
            if (updates.content) {
                updatedComment.content = this._sanitizeContent(updates.content);
            }

            // Validate anchor if updated
            if (updates.anchor) {
                updatedComment.anchor = this._validateAnchor(updates.anchor);
            }

            // Persist to MongoDB
            await this._saveComment(updatedComment);

            // Update cache
            this._commentCache.set(commentId, updatedComment);

            // Broadcast via WebSocket
            await this._broadcastCommentChange('updated', updatedComment);

            // Send notifications if significant change
            if (this._isSignificantUpdate(updates)) {
                await this._sendCommentNotifications(updatedComment, 'updated');
            }

            // Track metrics
            const latency = performance.now() - startTime;
            this._trackMetric('comment_update_latency', latency);
            this._trackMetric('comments_updated', 1);

            // Emit event
            this._emitCommentUpdated(updatedComment);

            console.log(`[CommentsSystem] Updated comment ${commentId} (${latency.toFixed(2)}ms)`);

            return updatedComment;

        } catch (error) {
            const updateError = new Error(`Failed to update comment: ${error.message}`);
            this._emitError(updateError);
            throw updateError;
        }
    }

    /**
     * Delete a comment.
     * 
     * @param commentId - Comment ID to delete
     * @param permanent - Whether to permanently delete (default: false, soft delete)
     * @returns Promise that resolves when deletion is complete
     */
    async deleteComment(commentId: string, permanent = false): Promise<void> {
        this._ensureInitialized();

        if (!commentId) {
            throw new Error('Comment ID is required for deletion');
        }

        try {
            const startTime = performance.now();

            // Get existing comment
            const existingComment = await this.getComment(commentId);
            if (!existingComment) {
                throw new Error(`Comment ${commentId} not found`);
            }

            // Check permissions
            if (!this._canDeleteComment(existingComment)) {
                throw new Error('Insufficient permissions to delete comment');
            }

            if (permanent) {
                // Permanent deletion
                await this._deleteCommentPermanently(commentId);
                this._commentCache.delete(commentId);
            } else {
                // Soft deletion
                const deletedComment: IComment = {
                    ...existingComment,
                    metadata: {
                        ...existingComment.metadata,
                        status: CommentStatus.DELETED,
                        version: existingComment.metadata.version + 1,
                        lastEdit: {
                            editedBy: this._currentUser!.userId,
                            editedAt: new Date(),
                            editType: CommentEditType.STATUS,
                            reason: 'Deleted by user'
                        }
                    },
                    timestamps: {
                        ...existingComment.timestamps,
                        updatedAt: new Date(),
                        scheduledDeletionAt: new Date(Date.now() + this._config.storage!.cleanup!.deletedCommentRetention! * 1000)
                    }
                };

                await this._saveComment(deletedComment);
                this._commentCache.set(commentId, deletedComment);
            }

            // Update thread metadata
            await this._updateThreadMetadata(existingComment.threadId);

            // Broadcast via WebSocket
            await this._broadcastCommentChange('deleted', existingComment);

            // Send notifications
            await this._sendCommentNotifications(existingComment, 'deleted');

            // Track metrics
            const latency = performance.now() - startTime;
            this._trackMetric('comment_delete_latency', latency);
            this._trackMetric('comments_deleted', 1);

            // Emit event
            this._emitCommentDeleted(existingComment);

            console.log(`[CommentsSystem] Deleted comment ${commentId} (permanent: ${permanent}) (${latency.toFixed(2)}ms)`);

        } catch (error) {
            const deleteError = new Error(`Failed to delete comment: ${error.message}`);
            this._emitError(deleteError);
            throw deleteError;
        }
    }

    /**
     * Resolve a comment or thread.
     * 
     * @param commentId - Comment ID to resolve
     * @param resolution - Resolution information
     * @returns Promise that resolves to the resolved comment
     */
    async resolveComment(
        commentId: string,
        resolution: Partial<ICommentResolution> = {}
    ): Promise<IComment> {
        this._ensureInitialized();

        if (!commentId) {
            throw new Error('Comment ID is required for resolution');
        }

        try {
            const startTime = performance.now();

            // Get existing comment
            const existingComment = await this.getComment(commentId);
            if (!existingComment) {
                throw new Error(`Comment ${commentId} not found`);
            }

            // Check permissions
            if (!this._canResolveComment(existingComment)) {
                throw new Error('Insufficient permissions to resolve comment');
            }

            // Create resolution
            const commentResolution: ICommentResolution = {
                resolvedBy: this._currentUser!.userId,
                resolvedAt: new Date(),
                reason: resolution.reason || 'Resolved by user',
                type: resolution.type || ResolutionType.ACCEPTED
            };

            // Update comment
            const resolvedComment: IComment = {
                ...existingComment,
                metadata: {
                    ...existingComment.metadata,
                    status: CommentStatus.RESOLVED,
                    resolution: commentResolution,
                    version: existingComment.metadata.version + 1,
                    lastEdit: {
                        editedBy: this._currentUser!.userId,
                        editedAt: new Date(),
                        editType: CommentEditType.STATUS,
                        reason: 'Comment resolved'
                    }
                },
                timestamps: {
                    ...existingComment.timestamps,
                    updatedAt: new Date(),
                    lastActivityAt: new Date()
                }
            };

            // Persist to MongoDB
            await this._saveComment(resolvedComment);

            // Update cache
            this._commentCache.set(commentId, resolvedComment);

            // Update thread metadata
            await this._updateThreadMetadata(existingComment.threadId);

            // Broadcast via WebSocket
            await this._broadcastCommentChange('resolved', resolvedComment);

            // Send notifications
            await this._sendCommentNotifications(resolvedComment, 'resolved');

            // Track metrics
            const latency = performance.now() - startTime;
            this._trackMetric('comment_resolve_latency', latency);
            this._trackMetric('comments_resolved', 1);

            // Emit event
            this._emitCommentResolved(resolvedComment);

            console.log(`[CommentsSystem] Resolved comment ${commentId} (${latency.toFixed(2)}ms)`);

            return resolvedComment;

        } catch (error) {
            const resolveError = new Error(`Failed to resolve comment: ${error.message}`);
            this._emitError(resolveError);
            throw resolveError;
        }
    }

    /**
     * Get a comment by ID.
     * 
     * @param commentId - Comment ID to retrieve
     * @param includeDeleted - Whether to include deleted comments
     * @returns Promise that resolves to the comment or null if not found
     */
    async getComment(commentId: string, includeDeleted = false): Promise<IComment | null> {
        this._ensureInitialized();

        if (!commentId) {
            return null;
        }

        try {
            // Check cache first
            const cached = this._commentCache.get(commentId);
            if (cached && (includeDeleted || cached.metadata.status !== CommentStatus.DELETED)) {
                return cached;
            }

            // Query MongoDB
            const filter: any = { commentId, documentId: this._documentId };
            if (!includeDeleted) {
                filter['metadata.status'] = { $ne: CommentStatus.DELETED };
            }

            const document = await this._collections.comments.findOne(filter);
            if (!document) {
                return null;
            }

            const comment = this._deserializeComment(document);

            // Check permissions
            if (!this._canViewComment(comment)) {
                return null;
            }

            // Cache the result
            this._commentCache.set(commentId, comment);

            return comment;

        } catch (error) {
            console.error(`[CommentsSystem] Error getting comment ${commentId}:`, error);
            return null;
        }
    }

    /**
     * Get comments for a cell.
     * 
     * @param cellId - Cell ID to get comments for
     * @param includeDeleted - Whether to include deleted comments
     * @returns Promise that resolves to array of comments
     */
    async getCommentsForCell(cellId: string, includeDeleted = false): Promise<IComment[]> {
        this._ensureInitialized();

        if (!cellId) {
            return [];
        }

        try {
            const startTime = performance.now();

            // Build query filter
            const filter: any = {
                documentId: this._documentId,
                'anchor.cellId': cellId
            };

            if (!includeDeleted) {
                filter['metadata.status'] = { $ne: CommentStatus.DELETED };
            }

            // Query MongoDB
            const documents = await this._collections.comments
                .find(filter)
                .sort({ 'timestamps.createdAt': 1 })
                .toArray();

            // Deserialize and filter by permissions
            const comments = documents
                .map(doc => this._deserializeComment(doc))
                .filter(comment => this._canViewComment(comment));

            // Update cache
            comments.forEach(comment => {
                this._commentCache.set(comment.commentId, comment);
            });

            // Track metrics
            const latency = performance.now() - startTime;
            this._trackMetric('cell_comments_query_latency', latency);

            console.log(`[CommentsSystem] Retrieved ${comments.length} comments for cell ${cellId} (${latency.toFixed(2)}ms)`);

            return comments;

        } catch (error) {
            console.error(`[CommentsSystem] Error getting comments for cell ${cellId}:`, error);
            return [];
        }
    }

    /**
     * Get a complete comment thread.
     * 
     * @param threadId - Thread ID to retrieve
     * @param includeDeleted - Whether to include deleted comments
     * @returns Promise that resolves to the comment thread
     */
    async getThread(threadId: string, includeDeleted = false): Promise<ICommentThread | null> {
        this._ensureInitialized();

        if (!threadId) {
            return null;
        }

        try {
            // Check cache first
            const cached = this._threadCache.get(threadId);
            if (cached) {
                return cached;
            }

            const startTime = performance.now();

            // Build query filter
            const filter: any = {
                documentId: this._documentId,
                threadId
            };

            if (!includeDeleted) {
                filter['metadata.status'] = { $ne: CommentStatus.DELETED };
            }

            // Query MongoDB
            const documents = await this._collections.comments
                .find(filter)
                .sort({ 'timestamps.createdAt': 1 })
                .toArray();

            if (documents.length === 0) {
                return null;
            }

            // Deserialize comments
            const comments = documents
                .map(doc => this._deserializeComment(doc))
                .filter(comment => this._canViewComment(comment));

            if (comments.length === 0) {
                return null;
            }

            // Build thread
            const thread = this._buildThread(threadId, comments);

            // Update caches
            this._threadCache.set(threadId, thread);
            comments.forEach(comment => {
                this._commentCache.set(comment.commentId, comment);
            });

            // Track metrics
            const latency = performance.now() - startTime;
            this._trackMetric('thread_query_latency', latency);

            console.log(`[CommentsSystem] Retrieved thread ${threadId} with ${comments.length} comments (${latency.toFixed(2)}ms)`);

            return thread;

        } catch (error) {
            console.error(`[CommentsSystem] Error getting thread ${threadId}:`, error);
            return null;
        }
    }

    /**
     * Search comments.
     * 
     * @param query - Search query parameters
     * @returns Promise that resolves to search results
     */
    async searchComments(query: ICommentSearchQuery): Promise<ICommentSearchResults> {
        this._ensureInitialized();

        try {
            const startTime = performance.now();

            // Build MongoDB aggregation pipeline
            const pipeline = this._buildSearchPipeline(query);

            // Execute search
            const results = await this._collections.comments.aggregate(pipeline).toArray();

            // Process results
            const comments = results
                .map(doc => this._deserializeComment(doc))
                .filter(comment => this._canViewComment(comment));

            // Build facets
            const facets = await this._buildSearchFacets(query, comments);

            // Track metrics
            const executionTime = performance.now() - startTime;
            this._trackMetric('search_latency', executionTime);
            this._trackMetric('searches_performed', 1);

            const searchResults: ICommentSearchResults = {
                comments,
                totalCount: comments.length,
                executionTime,
                facets,
                metadata: {
                    query,
                    timestamp: new Date().toISOString()
                }
            };

            console.log(`[CommentsSystem] Search completed: ${comments.length} results (${executionTime.toFixed(2)}ms)`);

            return searchResults;

        } catch (error) {
            const searchError = new Error(`Failed to search comments: ${error.message}`);
            this._emitError(searchError);
            throw searchError;
        }
    }

    /**
     * Export comments for a document.
     * 
     * @param format - Export format
     * @param options - Export options
     * @returns Promise that resolves to exported data
     */
    async exportComments(
        format: 'json' | 'csv' | 'markdown',
        options: Partial<{
            includeDeleted: boolean;
            includeResolved: boolean;
            cellIds: string[];
            dateRange: IDateRange;
        }> = {}
    ): Promise<string> {
        this._ensureInitialized();

        try {
            const startTime = performance.now();

            // Build export filter
            const filter = this._buildExportFilter(options);

            // Query comments
            const documents = await this._collections.comments
                .find(filter)
                .sort({ 'timestamps.createdAt': 1 })
                .toArray();

            const comments = documents
                .map(doc => this._deserializeComment(doc))
                .filter(comment => this._canViewComment(comment));

            // Export in requested format
            let exportData: string;
            switch (format) {
                case 'json':
                    exportData = JSON.stringify(comments, null, 2);
                    break;
                case 'csv':
                    exportData = this._exportToCsv(comments);
                    break;
                case 'markdown':
                    exportData = this._exportToMarkdown(comments);
                    break;
                default:
                    throw new Error(`Unsupported export format: ${format}`);
            }

            // Track metrics
            const latency = performance.now() - startTime;
            this._trackMetric('export_latency', latency);
            this._trackMetric('exports_performed', 1);

            console.log(`[CommentsSystem] Exported ${comments.length} comments in ${format} format (${latency.toFixed(2)}ms)`);

            return exportData;

        } catch (error) {
            const exportError = new Error(`Failed to export comments: ${error.message}`);
            this._emitError(exportError);
            throw exportError;
        }
    }

    /**
     * Import comments from external data.
     * 
     * @param data - Import data
     * @param format - Data format
     * @param options - Import options
     * @returns Promise that resolves to import results
     */
    async importComments(
        data: string,
        format: 'json' | 'csv',
        options: Partial<{
            overwrite: boolean;
            validateAnchors: boolean;
            assignToCurrentUser: boolean;
        }> = {}
    ): Promise<{ imported: number; skipped: number; errors: string[] }> {
        this._ensureInitialized();

        try {
            const startTime = performance.now();
            let imported = 0;
            let skipped = 0;
            const errors: string[] = [];

            // Parse import data
            let comments: Partial<IComment>[];
            switch (format) {
                case 'json':
                    comments = JSON.parse(data);
                    break;
                case 'csv':
                    comments = this._parseCsvImport(data);
                    break;
                default:
                    throw new Error(`Unsupported import format: ${format}`);
            }

            // Process each comment
            for (const commentData of comments) {
                try {
                    // Validate and transform
                    const processedComment = await this._processImportComment(commentData, options);
                    
                    if (processedComment) {
                        await this._saveComment(processedComment);
                        imported++;
                    } else {
                        skipped++;
                    }
                } catch (error) {
                    errors.push(`Comment ${commentData.commentId}: ${error.message}`);
                    skipped++;
                }
            }

            // Track metrics
            const latency = performance.now() - startTime;
            this._trackMetric('import_latency', latency);
            this._trackMetric('imports_performed', 1);

            console.log(`[CommentsSystem] Import completed: ${imported} imported, ${skipped} skipped (${latency.toFixed(2)}ms)`);

            return { imported, skipped, errors };

        } catch (error) {
            const importError = new Error(`Failed to import comments: ${error.message}`);
            this._emitError(importError);
            throw importError;
        }
    }

    /**
     * Get system metrics.
     * 
     * @returns Current system metrics
     */
    getMetrics(): Record<string, number> {
        return Object.fromEntries(this._metrics);
    }

    /**
     * Dispose of the comments system and clean up resources.
     */
    dispose(): void {
        if (this._isDisposed) {
            return;
        }

        console.log('[CommentsSystem] Disposing comments system...');

        // Clear timers
        if (this._websocketReconnectTimer) {
            clearTimeout(this._websocketReconnectTimer);
            this._websocketReconnectTimer = null;
        }

        // Close WebSocket connection
        if (this._websocket) {
            this._websocket.close();
            this._websocket = null;
        }

        // Close MongoDB connection
        if (this._mongoClient) {
            this._mongoClient.close().catch(error => {
                console.error('[CommentsSystem] Error closing MongoDB connection:', error);
            });
            this._mongoClient = null;
        }

        // Clear caches
        this._commentCache.clear();
        this._threadCache.clear();
        this._userPreferencesCache.clear();
        this._pendingOperations.clear();

        // Mark as disposed
        this._isDisposed = true;

        // Emit disposal signal
        this._disposed.emit();

        // Clear all signals
        Signal.clearData(this);

        console.log('[CommentsSystem] Comments system disposed');
    }

    // Private implementation methods

    /**
     * Merge configuration with defaults.
     */
    private _mergeConfig(config: Partial<ICommentsConfig>): ICommentsConfig {
        return {
            ...DEFAULT_COMMENTS_CONFIG,
            ...config,
            mongodb: {
                ...DEFAULT_COMMENTS_CONFIG.mongodb!,
                ...config.mongodb
            },
            websocket: {
                ...DEFAULT_COMMENTS_CONFIG.websocket!,
                ...config.websocket
            },
            notifications: {
                ...DEFAULT_COMMENTS_CONFIG.notifications!,
                ...config.notifications
            },
            search: {
                ...DEFAULT_COMMENTS_CONFIG.search!,
                ...config.search
            },
            storage: {
                ...DEFAULT_COMMENTS_CONFIG.storage!,
                ...config.storage
            },
            security: {
                ...DEFAULT_COMMENTS_CONFIG.security!,
                ...config.security
            },
            features: {
                ...DEFAULT_COMMENTS_CONFIG.features!,
                ...config.features
            },
            performance: {
                ...DEFAULT_COMMENTS_CONFIG.performance!,
                ...config.performance
            }
        } as ICommentsConfig;
    }

    /**
     * Set up current user from awareness system.
     */
    private _setupCurrentUser(): void {
        // Get user info from collaboration provider
        const userInfo = this._collaborationProvider.config.userInfo;
        
        if (userInfo) {
            this._currentUser = {
                userId: userInfo.userId,
                displayName: userInfo.displayName,
                avatar: userInfo.avatar,
                role: (userInfo.role as UserRole) || UserRole.EDITOR,
                email: undefined, // Would come from user profile
                metadata: {}
            };
        }
    }

    /**
     * Set up collaboration provider event listeners.
     */
    private _setupCollaborationListeners(): void {
        // Listen for connection state changes
        this._collaborationProvider.connectionStateChanged.connect((_, state) => {
            if (state === ConnectionState.CONNECTED && this._isInitialized) {
                // Reconnect WebSocket if needed
                this._ensureWebSocketConnection();
            }
        });

        // Listen for document changes
        this._collaborationProvider.contentChanged.connect((_, event) => {
            // Handle cell deletions that might affect comment anchors
            if (event.type === 'cell_deleted') {
                this._handleCellDeletion(event.data as any);
            }
        });
    }

    /**
     * Initialize MongoDB connection and collections.
     */
    private async _initializeMongoDB(): Promise<void> {
        try {
            // Dynamic import of MongoDB driver
            const { MongoClient } = await import('mongodb');

            // Create MongoDB client
            this._mongoClient = new MongoClient(
                this._config.mongodb.connectionUrl,
                this._config.mongodb.options
            );

            // Connect to MongoDB
            await this._mongoClient.connect();
            
            // Get database
            this._database = this._mongoClient.db(this._config.mongodb.databaseName);

            console.log('[CommentsSystem] MongoDB connection established');

        } catch (error) {
            throw new Error(`Failed to initialize MongoDB: ${error.message}`);
        }
    }

    /**
     * Set up MongoDB collections and indexes.
     */
    private async _setupCollections(): Promise<void> {
        try {
            const collections = this._config.mongodb.collections;

            // Get collections
            this._collections = {
                comments: this._database.collection(collections.comments),
                threads: this._database.collection(collections.threads),
                notifications: this._database.collection(collections.notifications),
                attachments: this._database.collection(collections.attachments),
                userPreferences: this._database.collection(collections.userPreferences)
            };

            // Create indexes
            await this._createIndexes();

            console.log('[CommentsSystem] MongoDB collections and indexes set up');

        } catch (error) {
            throw new Error(`Failed to set up MongoDB collections: ${error.message}`);
        }
    }

    /**
     * Create MongoDB indexes for performance.
     */
    private async _createIndexes(): Promise<void> {
        const { comments, threads, notifications } = this._collections;

        // Comments collection indexes
        await comments.createIndex({ commentId: 1 }, { unique: true });
        await comments.createIndex({ documentId: 1, 'anchor.cellId': 1 });
        await comments.createIndex({ threadId: 1, 'timestamps.createdAt': 1 });
        await comments.createIndex({ 'author.userId': 1 });
        await comments.createIndex({ 'metadata.status': 1 });
        await comments.createIndex({ 'timestamps.createdAt': 1 });

        // Text search index
        if (this._config.mongodb.indexes.textSearch) {
            await comments.createIndex(
                { 
                    'content.text': 'text',
                    'content.html': 'text',
                    tags: 'text'
                },
                { 
                    weights: {
                        'content.text': 10,
                        'content.html': 5,
                        tags: 3
                    }
                }
            );
        }

        // Threads collection indexes
        await threads.createIndex({ threadId: 1 }, { unique: true });
        await threads.createIndex({ documentId: 1 });
        await threads.createIndex({ 'metadata.lastActivityAt': 1 });

        // Notifications collection indexes
        await notifications.createIndex({ notificationId: 1 }, { unique: true });
        await notifications.createIndex({ userId: 1, status: 1 });
        await notifications.createIndex({ 'timestamps.createdAt': 1 });

        // TTL indexes
        for (const ttlConfig of this._config.mongodb.indexes.ttlIndexes) {
            const collection = this._collections[ttlConfig.collection];
            if (collection) {
                await collection.createIndex(
                    { [ttlConfig.field]: 1 },
                    { expireAfterSeconds: ttlConfig.expireAfterSeconds }
                );
            }
        }

        console.log('[CommentsSystem] MongoDB indexes created');
    }

    /**
     * Initialize WebSocket connection for real-time communication.
     */
    private async _initializeWebSocket(): Promise<void> {
        try {
            const wsUrl = this._config.websocket.endpoint;
            this._websocket = new WebSocket(wsUrl);

            // Set up event handlers
            this._websocket.onopen = () => {
                console.log('[CommentsSystem] WebSocket connection established');
                
                // Subscribe to comment channel
                this._websocket!.send(JSON.stringify({
                    type: 'subscribe',
                    channel: this._config.websocket.channel,
                    documentId: this._documentId,
                    sessionId: this._sessionId
                }));
            };

            this._websocket.onmessage = (event) => {
                this._handleWebSocketMessage(event);
            };

            this._websocket.onclose = () => {
                console.log('[CommentsSystem] WebSocket connection closed');
                this._scheduleWebSocketReconnection();
            };

            this._websocket.onerror = (error) => {
                console.error('[CommentsSystem] WebSocket error:', error);
            };

            // Wait for connection
            await this._waitForWebSocketConnection();

        } catch (error) {
            throw new Error(`Failed to initialize WebSocket: ${error.message}`);
        }
    }

    /**
     * Wait for WebSocket connection to be established.
     */
    private async _waitForWebSocketConnection(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('WebSocket connection timeout'));
            }, this._config.websocket.options.ackTimeout);

            const checkConnection = () => {
                if (this._websocket?.readyState === WebSocket.OPEN) {
                    clearTimeout(timeout);
                    resolve();
                } else {
                    setTimeout(checkConnection, 100);
                }
            };

            checkConnection();
        });
    }

    /**
     * Ensure WebSocket connection is active.
     */
    private _ensureWebSocketConnection(): void {
        if (!this._websocket || this._websocket.readyState !== WebSocket.OPEN) {
            this._initializeWebSocket().catch(error => {
                console.error('[CommentsSystem] Failed to reconnect WebSocket:', error);
                this._scheduleWebSocketReconnection();
            });
        }
    }

    /**
     * Schedule WebSocket reconnection.
     */
    private _scheduleWebSocketReconnection(): void {
        if (this._websocketReconnectTimer) {
            clearTimeout(this._websocketReconnectTimer);
        }

        this._websocketReconnectTimer = setTimeout(() => {
            this._ensureWebSocketConnection();
        }, this._config.websocket.options.reconnectionDelay);
    }

    /**
     * Handle incoming WebSocket messages.
     */
    private _handleWebSocketMessage(event: MessageEvent): void {
        try {
            const message = JSON.parse(event.data);
            
            switch (message.type) {
                case this._config.websocket.messageTypes.commentCreated:
                    this._handleRemoteCommentCreated(message.data);
                    break;
                case this._config.websocket.messageTypes.commentUpdated:
                    this._handleRemoteCommentUpdated(message.data);
                    break;
                case this._config.websocket.messageTypes.commentDeleted:
                    this._handleRemoteCommentDeleted(message.data);
                    break;
                case this._config.websocket.messageTypes.commentResolved:
                    this._handleRemoteCommentResolved(message.data);
                    break;
                case this._config.websocket.messageTypes.threadStatusChanged:
                    this._handleRemoteThreadStatusChanged(message.data);
                    break;
                default:
                    console.warn('[CommentsSystem] Unknown WebSocket message type:', message.type);
            }

        } catch (error) {
            console.error('[CommentsSystem] Error handling WebSocket message:', error);
        }
    }

    /**
     * Handle remote comment creation.
     */
    private _handleRemoteCommentCreated(commentData: any): void {
        try {
            const comment = this._deserializeComment(commentData);
            
            // Update cache
            this._commentCache.set(comment.commentId, comment);
            
            // Clear thread cache to force refresh
            this._threadCache.delete(comment.threadId);
            
            // Emit event
            this._emitCommentCreated(comment);
            
        } catch (error) {
            console.error('[CommentsSystem] Error handling remote comment creation:', error);
        }
    }

    /**
     * Handle remote comment update.
     */
    private _handleRemoteCommentUpdated(commentData: any): void {
        try {
            const comment = this._deserializeComment(commentData);
            
            // Update cache
            this._commentCache.set(comment.commentId, comment);
            
            // Clear thread cache to force refresh
            this._threadCache.delete(comment.threadId);
            
            // Emit event
            this._emitCommentUpdated(comment);
            
        } catch (error) {
            console.error('[CommentsSystem] Error handling remote comment update:', error);
        }
    }

    /**
     * Handle remote comment deletion.
     */
    private _handleRemoteCommentDeleted(commentData: any): void {
        try {
            const comment = this._deserializeComment(commentData);
            
            // Update cache
            if (comment.metadata.status === CommentStatus.DELETED) {
                this._commentCache.set(comment.commentId, comment);
            } else {
                this._commentCache.delete(comment.commentId);
            }
            
            // Clear thread cache to force refresh
            this._threadCache.delete(comment.threadId);
            
            // Emit event
            this._emitCommentDeleted(comment);
            
        } catch (error) {
            console.error('[CommentsSystem] Error handling remote comment deletion:', error);
        }
    }

    /**
     * Handle remote comment resolution.
     */
    private _handleRemoteCommentResolved(commentData: any): void {
        try {
            const comment = this._deserializeComment(commentData);
            
            // Update cache
            this._commentCache.set(comment.commentId, comment);
            
            // Clear thread cache to force refresh
            this._threadCache.delete(comment.threadId);
            
            // Emit event
            this._emitCommentResolved(comment);
            
        } catch (error) {
            console.error('[CommentsSystem] Error handling remote comment resolution:', error);
        }
    }

    /**
     * Handle remote thread status change.
     */
    private _handleRemoteThreadStatusChanged(threadData: any): void {
        try {
            // Clear thread cache to force refresh
            this._threadCache.delete(threadData.threadId);
            
            // Emit event
            this._emitThreadUpdated(threadData);
            
        } catch (error) {
            console.error('[CommentsSystem] Error handling remote thread status change:', error);
        }
    }

    /**
     * Set up performance monitoring.
     */
    private _setupPerformanceMonitoring(): void {
        // Initialize metrics
        this._metrics.set('comments_created', 0);
        this._metrics.set('comments_updated', 0);
        this._metrics.set('comments_deleted', 0);
        this._metrics.set('comments_resolved', 0);
        this._metrics.set('searches_performed', 0);
        this._metrics.set('exports_performed', 0);
        this._metrics.set('imports_performed', 0);
    }

    /**
     * Set up cleanup routines.
     */
    private _setupCleanupRoutines(): void {
        // Set up periodic cleanup
        setInterval(() => {
            this._performCleanup();
        }, 60000); // Every minute
    }

    /**
     * Perform periodic cleanup.
     */
    private async _performCleanup(): Promise<void> {
        try {
            const now = Date.now();
            
            // Skip if cleanup was recent
            if (now - this._lastCleanupTime < 300000) { // 5 minutes
                return;
            }

            // Clean up caches
            this._cleanupCaches();

            // Clean up pending operations
            this._cleanupPendingOperations();

            // Database cleanup (if enabled)
            if (this._config.storage.cleanup.enabled) {
                await this._performDatabaseCleanup();
            }

            this._lastCleanupTime = now;

        } catch (error) {
            console.error('[CommentsSystem] Error during cleanup:', error);
        }
    }

    /**
     * Clean up in-memory caches.
     */
    private _cleanupCaches(): void {
        const maxCacheSize = this._config.performance.cache.maxSize;
        
        // Clean comment cache
        if (this._commentCache.size > maxCacheSize) {
            const entries = Array.from(this._commentCache.entries());
            entries.sort((a, b) => {
                const aTime = a[1].timestamps.lastActivityAt.getTime();
                const bTime = b[1].timestamps.lastActivityAt.getTime();
                return aTime - bTime; // Oldest first
            });
            
            const toRemove = entries.slice(0, entries.length - maxCacheSize);
            toRemove.forEach(([id]) => this._commentCache.delete(id));
        }

        // Clean thread cache
        if (this._threadCache.size > maxCacheSize / 2) {
            const entries = Array.from(this._threadCache.entries());
            entries.sort((a, b) => {
                const aTime = a[1].metadata.lastActivityAt.getTime();
                const bTime = b[1].metadata.lastActivityAt.getTime();
                return aTime - bTime; // Oldest first
            });
            
            const toRemove = entries.slice(0, entries.length - Math.floor(maxCacheSize / 2));
            toRemove.forEach(([id]) => this._threadCache.delete(id));
        }
    }

    /**
     * Clean up pending operations.
     */
    private _cleanupPendingOperations(): void {
        const now = Date.now();
        const timeout = 60000; // 1 minute

        for (const [id, promise] of this._pendingOperations.entries()) {
            // Check if operation has been pending too long
            // This is a simplified check - in reality you'd track start times
            this._pendingOperations.delete(id);
        }
    }

    /**
     * Perform database cleanup.
     */
    private async _performDatabaseCleanup(): Promise<void> {
        try {
            const now = new Date();
            const retention = this._config.storage.cleanup.deletedCommentRetention * 1000;
            const cutoffDate = new Date(now.getTime() - retention);

            // Delete expired soft-deleted comments
            await this._collections.comments.deleteMany({
                'metadata.status': CommentStatus.DELETED,
                'timestamps.scheduledDeletionAt': { $lt: cutoffDate }
            });

            // Delete old notifications
            await this._collections.notifications.deleteMany({
                'timestamps.createdAt': { $lt: cutoffDate }
            });

            console.log('[CommentsSystem] Database cleanup completed');

        } catch (error) {
            console.error('[CommentsSystem] Error during database cleanup:', error);
        }
    }

    /**
     * Sanitize comment content.
     */
    private _sanitizeContent(content: ICommentContent): ICommentContent {
        const config = this._config.security.sanitization;
        
        if (!config.enabled) {
            return content;
        }

        // Sanitize HTML content if present
        if (content.html) {
            // This is a simplified sanitization - in production use a library like DOMPurify
            content.html = this._sanitizeHtml(content.html, config);
        }

        // Ensure text content is clean
        content.text = content.text.trim().substring(0, 10000); // Limit length

        return content;
    }

    /**
     * Simplified HTML sanitization.
     */
    private _sanitizeHtml(html: string, config: ISanitizationConfig): string {
        // This is a basic implementation - use DOMPurify or similar in production
        
        // Remove script tags
        html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        
        // Remove on* event handlers
        html = html.replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '');
        
        // Basic tag filtering (simplified)
        const allowedTags = config.allowedTags.join('|');
        const tagRegex = new RegExp(`<(?!\/?(?:${allowedTags})(?:\s|>))[^>]+>`, 'gi');
        html = html.replace(tagRegex, '');
        
        return html;
    }

    /**
     * Validate comment anchor.
     */
    private _validateAnchor(anchor: ICommentAnchor): ICommentAnchor {
        // Validate cell ID exists in the document
        // This would need integration with the notebook model
        
        // Validate anchor position
        if (anchor.type === CommentAnchorType.LINE && anchor.lineNumber !== undefined) {
            anchor.lineNumber = Math.max(0, anchor.lineNumber);
        }
        
        if (anchor.characterOffset !== undefined) {
            anchor.characterOffset = Math.max(0, anchor.characterOffset);
        }
        
        return anchor;
    }

    /**
     * Get default comment visibility.
     */
    private _getDefaultVisibility(): ICommentVisibility {
        return {
            scope: VisibilityScope.PUBLIC,
            allowedUsers: [],
            allowedRoles: [UserRole.EDITOR, UserRole.ADMIN, UserRole.OWNER],
            permissions: {
                canView: true,
                canReply: true,
                canEdit: false,
                canDelete: false,
                canResolve: true,
                canModerate: false
            }
        };
    }

    /**
     * Check rate limiting for user.
     */
    private async _checkRateLimit(userId: string): Promise<void> {
        const config = this._config.security.rateLimiting;
        
        if (!config.enabled) {
            return;
        }

        // This is a simplified rate limiting implementation
        // In production, use Redis or a dedicated rate limiting service
        
        const now = Date.now();
        const minuteAgo = now - 60000;
        
        // Count recent comments for this user
        const recentCount = await this._collections.comments.countDocuments({
            'author.userId': userId,
            'timestamps.createdAt': { $gte: new Date(minuteAgo) }
        });
        
        if (recentCount >= config.commentsPerMinute) {
            throw new Error('Rate limit exceeded. Please slow down.');
        }
    }

    /**
     * Save comment to MongoDB.
     */
    private async _saveComment(comment: IComment): Promise<void> {
        const document = this._serializeComment(comment);
        
        await this._collections.comments.replaceOne(
            { commentId: comment.commentId },
            document,
            { upsert: true }
        );
    }

    /**
     * Serialize comment for MongoDB storage.
     */
    private _serializeComment(comment: IComment): any {
        return {
            ...comment,
            documentId: this._documentId,
            sessionId: this._sessionId,
            // Convert dates to proper MongoDB format
            timestamps: {
                ...comment.timestamps,
                createdAt: new Date(comment.timestamps.createdAt),
                updatedAt: new Date(comment.timestamps.updatedAt),
                lastActivityAt: new Date(comment.timestamps.lastActivityAt),
                scheduledDeletionAt: comment.timestamps.scheduledDeletionAt ? 
                    new Date(comment.timestamps.scheduledDeletionAt) : undefined
            }
        };
    }

    /**
     * Deserialize comment from MongoDB document.
     */
    private _deserializeComment(document: any): IComment {
        return {
            ...document,
            // Convert dates back from MongoDB format
            timestamps: {
                ...document.timestamps,
                createdAt: new Date(document.timestamps.createdAt),
                updatedAt: new Date(document.timestamps.updatedAt),
                lastActivityAt: new Date(document.timestamps.lastActivityAt),
                scheduledDeletionAt: document.timestamps.scheduledDeletionAt ? 
                    new Date(document.timestamps.scheduledDeletionAt) : undefined
            }
        };
    }

    /**
     * Get thread ID for a comment.
     */
    private async _getThreadId(commentId: string): Promise<string> {
        const comment = await this.getComment(commentId);
        return comment ? comment.threadId : commentId;
    }

    /**
     * Update thread metadata.
     */
    private async _updateThreadMetadata(threadId: string): Promise<void> {
        try {
            // Get all comments in thread
            const comments = await this._collections.comments
                .find({ 
                    documentId: this._documentId,
                    threadId,
                    'metadata.status': { $ne: CommentStatus.DELETED }
                })
                .sort({ 'timestamps.createdAt': 1 })
                .toArray();

            if (comments.length === 0) {
                return;
            }

            // Calculate thread statistics
            const participantIds = new Set(comments.map(c => c.author.userId));
            const unresolvedCount = comments.filter(c => c.metadata.status !== CommentStatus.RESOLVED).length;
            const lastActivity = Math.max(...comments.map(c => c.timestamps.lastActivityAt.getTime()));

            // Create thread metadata
            const threadMetadata: IThreadMetadata = {
                createdAt: new Date(comments[0].timestamps.createdAt),
                lastActivityAt: new Date(lastActivity),
                createdBy: comments[0].author.userId,
                status: unresolvedCount > 0 ? ThreadStatus.ACTIVE : ThreadStatus.RESOLVED,
                tags: [...new Set(comments.flatMap(c => c.tags))],
                priority: Math.max(...comments.map(c => {
                    switch (c.metadata.priority) {
                        case CommentPriority.URGENT: return 4;
                        case CommentPriority.HIGH: return 3;
                        case CommentPriority.NORMAL: return 2;
                        case CommentPriority.LOW: return 1;
                        default: return 2;
                    }
                })) as any // Convert back to enum
            };

            // Update thread document
            await this._collections.threads.replaceOne(
                { threadId },
                {
                    threadId,
                    documentId: this._documentId,
                    metadata: threadMetadata,
                    statistics: {
                        commentCount: comments.length,
                        participantCount: participantIds.size,
                        unresolvedCount,
                        maxDepth: this._calculateMaxDepth(comments),
                        averageResponseTime: this._calculateAverageResponseTime(comments)
                    }
                },
                { upsert: true }
            );

            // Clear thread cache
            this._threadCache.delete(threadId);

        } catch (error) {
            console.error(`[CommentsSystem] Error updating thread metadata for ${threadId}:`, error);
        }
    }

    /**
     * Calculate maximum thread depth.
     */
    private _calculateMaxDepth(comments: any[]): number {
        const parentMap = new Map<string, string>();
        comments.forEach(c => {
            if (c.parentId) {
                parentMap.set(c.commentId, c.parentId);
            }
        });

        let maxDepth = 1;
        
        for (const comment of comments) {
            let depth = 1;
            let current = comment.commentId;
            
            while (parentMap.has(current)) {
                depth++;
                current = parentMap.get(current)!;
            }
            
            maxDepth = Math.max(maxDepth, depth);
        }

        return maxDepth;
    }

    /**
     * Calculate average response time in thread.
     */
    private _calculateAverageResponseTime(comments: any[]): number {
        if (comments.length < 2) {
            return 0;
        }

        const parentMap = new Map<string, any>();
        comments.forEach(c => {
            parentMap.set(c.commentId, c);
        });

        const responseTimes: number[] = [];
        
        for (const comment of comments) {
            if (comment.parentId && parentMap.has(comment.parentId)) {
                const parent = parentMap.get(comment.parentId);
                const responseTime = comment.timestamps.createdAt.getTime() - parent.timestamps.createdAt.getTime();
                responseTimes.push(responseTime);
            }
        }

        return responseTimes.length > 0 ? 
            responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length : 0;
    }

    /**
     * Build comment thread from comments.
     */
    private _buildThread(threadId: string, comments: IComment[]): ICommentThread {
        // Get thread metadata
        const participants = new Map<string, ICommentAuthor>();
        comments.forEach(comment => {
            participants.set(comment.author.userId, comment.author);
        });

        const statistics: IThreadStatistics = {
            commentCount: comments.length,
            participantCount: participants.size,
            unresolvedCount: comments.filter(c => c.metadata.status !== CommentStatus.RESOLVED).length,
            maxDepth: this._calculateMaxDepth(comments),
            averageResponseTime: this._calculateAverageResponseTime(comments)
        };

        return {
            threadId,
            comments,
            metadata: {
                createdAt: comments[0].timestamps.createdAt,
                lastActivityAt: new Date(Math.max(...comments.map(c => c.timestamps.lastActivityAt.getTime()))),
                createdBy: comments[0].author.userId,
                status: statistics.unresolvedCount > 0 ? ThreadStatus.ACTIVE : ThreadStatus.RESOLVED,
                tags: [...new Set(comments.flatMap(c => c.tags))],
                priority: CommentPriority.NORMAL // Default priority
            },
            participants: Array.from(participants.values()),
            statistics
        };
    }

    /**
     * Broadcast comment change via WebSocket.
     */
    private async _broadcastCommentChange(
        action: 'created' | 'updated' | 'deleted' | 'resolved',
        comment: IComment
    ): Promise<void> {
        if (!this._websocket || this._websocket.readyState !== WebSocket.OPEN) {
            return;
        }

        try {
            const messageType = this._config.websocket.messageTypes[`comment${action.charAt(0).toUpperCase() + action.slice(1)}` as keyof IWebSocketMessageTypes];
            
            const message = {
                type: messageType,
                data: this._serializeComment(comment),
                timestamp: Date.now(),
                userId: this._currentUser?.userId,
                sessionId: this._sessionId
            };

            this._websocket.send(JSON.stringify(message));

        } catch (error) {
            console.error('[CommentsSystem] Error broadcasting comment change:', error);
        }
    }

    /**
     * Send comment notifications.
     */
    private async _sendCommentNotifications(
        comment: IComment,
        action: 'created' | 'updated' | 'deleted' | 'resolved'
    ): Promise<void> {
        if (!this._config.notifications.enabled) {
            return;
        }

        try {
            // Determine notification recipients
            const recipients = await this._getNotificationRecipients(comment, action);

            // Send notifications to each recipient
            for (const recipient of recipients) {
                await this._sendNotificationToUser(recipient, comment, action);
            }

        } catch (error) {
            console.error('[CommentsSystem] Error sending comment notifications:', error);
        }
    }

    /**
     * Get notification recipients for a comment.
     */
    private async _getNotificationRecipients(
        comment: IComment,
        action: string
    ): Promise<string[]> {
        const recipients = new Set<string>();

        // Add thread participants
        if (comment.parentId) {
            const thread = await this.getThread(comment.threadId);
            if (thread) {
                thread.participants.forEach(p => recipients.add(p.userId));
            }
        }

        // Add mentioned users
        comment.content.mentions.forEach(mention => {
            if (mention.type === MentionType.USER) {
                recipients.add(mention.userId);
            }
        });

        // Remove the comment author (don't notify yourself)
        recipients.delete(comment.author.userId);

        return Array.from(recipients);
    }

    /**
     * Send notification to a specific user.
     */
    private async _sendNotificationToUser(
        userId: string,
        comment: IComment,
        action: string
    ): Promise<void> {
        try {
            // Get user preferences
            const preferences = await this._getUserNotificationPreferences(userId);
            
            // Check if user wants this type of notification
            const notificationType = this._mapActionToNotificationType(action);
            if (!preferences.enabledTypes.includes(notificationType)) {
                return;
            }

            // Create notification
            const notification: ICommentNotification = {
                notificationId: UUID.uuid4(),
                userId,
                type: notificationType,
                relatedId: comment.commentId,
                content: this._createNotificationContent(comment, action),
                status: NotificationStatus.PENDING,
                channels: preferences.channelPreferences.get(notificationType) || [NotificationChannel.IN_APP],
                timestamps: {
                    createdAt: new Date(),
                    scheduledAt: new Date()
                },
                metadata: {
                    documentId: this._documentId,
                    sessionId: this._sessionId,
                    threadId: comment.threadId
                }
            };

            // Save notification
            await this._collections.notifications.insertOne(notification);

            // Send via configured channels
            await this._deliverNotification(notification);

            // Emit event
            this._emitNotificationSent(notification);

        } catch (error) {
            console.error(`[CommentsSystem] Error sending notification to user ${userId}:`, error);
        }
    }

    /**
     * Get user notification preferences.
     */
    private async _getUserNotificationPreferences(userId: string): Promise<INotificationPreferences> {
        // Check cache first
        const cached = this._userPreferencesCache.get(userId);
        if (cached) {
            return cached;
        }

        try {
            // Query from MongoDB
            const document = await this._collections.userPreferences.findOne({ userId });
            
            const preferences = document?.preferences || this._config.notifications.defaultPreferences;
            
            // Cache the result
            this._userPreferencesCache.set(userId, preferences);
            
            return preferences;

        } catch (error) {
            console.error(`[CommentsSystem] Error getting user preferences for ${userId}:`, error);
            return this._config.notifications.defaultPreferences;
        }
    }

    /**
     * Map action to notification type.
     */
    private _mapActionToNotificationType(action: string): NotificationType {
        switch (action) {
            case 'created':
                return NotificationType.COMMENT_CREATED;
            case 'updated':
                return NotificationType.COMMENT_EDITED;
            case 'resolved':
                return NotificationType.COMMENT_RESOLVED;
            default:
                return NotificationType.COMMENT_CREATED;
        }
    }

    /**
     * Create notification content.
     */
    private _createNotificationContent(comment: IComment, action: string): INotificationContent {
        const authorName = comment.author.displayName;
        const cellId = comment.anchor.cellId;
        
        let title: string;
        let message: string;
        
        switch (action) {
            case 'created':
                title = `New comment from ${authorName}`;
                message = `${authorName} commented on cell ${cellId}: ${comment.content.text.substring(0, 100)}...`;
                break;
            case 'updated':
                title = `Comment updated by ${authorName}`;
                message = `${authorName} updated their comment on cell ${cellId}`;
                break;
            case 'resolved':
                title = `Comment resolved by ${authorName}`;
                message = `${authorName} resolved a comment on cell ${cellId}`;
                break;
            default:
                title = `Comment notification`;
                message = `Activity on cell ${cellId}`;
        }

        return {
            title,
            message,
            actions: [
                {
                    actionId: 'view',
                    label: 'View Comment',
                    target: `#comment-${comment.commentId}`,
                    type: NotificationActionType.URL,
                    style: ActionStyle.PRIMARY
                }
            ],
            context: {
                commentId: comment.commentId,
                threadId: comment.threadId,
                cellId: comment.anchor.cellId
            }
        };
    }

    /**
     * Deliver notification via configured channels.
     */
    private async _deliverNotification(notification: ICommentNotification): Promise<void> {
        for (const channel of notification.channels) {
            try {
                switch (channel) {
                    case NotificationChannel.IN_APP:
                        await this._deliverInAppNotification(notification);
                        break;
                    case NotificationChannel.WEBSOCKET:
                        await this._deliverWebSocketNotification(notification);
                        break;
                    case NotificationChannel.EMAIL:
                        await this._deliverEmailNotification(notification);
                        break;
                    // Add other channels as needed
                }
            } catch (error) {
                console.error(`[CommentsSystem] Error delivering notification via ${channel}:`, error);
            }
        }

        // Update notification status
        notification.status = NotificationStatus.DELIVERED;
        notification.timestamps.deliveredAt = new Date();
        
        await this._collections.notifications.updateOne(
            { notificationId: notification.notificationId },
            { $set: notification }
        );
    }

    /**
     * Deliver in-app notification.
     */
    private async _deliverInAppNotification(notification: ICommentNotification): Promise<void> {
        // In-app notifications would be handled by the UI layer
        // This is just a placeholder for the notification event
        console.log(`[CommentsSystem] In-app notification for user ${notification.userId}`);
    }

    /**
     * Deliver WebSocket notification.
     */
    private async _deliverWebSocketNotification(notification: ICommentNotification): Promise<void> {
        if (!this._websocket || this._websocket.readyState !== WebSocket.OPEN) {
            return;
        }

        const message = {
            type: 'notification',
            data: notification,
            timestamp: Date.now()
        };

        this._websocket.send(JSON.stringify(message));
    }

    /**
     * Deliver email notification.
     */
    private async _deliverEmailNotification(notification: ICommentNotification): Promise<void> {
        // Email delivery would integrate with an email service
        // This is a placeholder implementation
        console.log(`[CommentsSystem] Email notification for user ${notification.userId}`);
    }

    /**
     * Build search pipeline for MongoDB.
     */
    private _buildSearchPipeline(query: ICommentSearchQuery): any[] {
        const pipeline: any[] = [];

        // Match stage
        const matchStage: any = {
            documentId: this._documentId,
            'metadata.status': { $ne: CommentStatus.DELETED }
        };

        // Text search
        if (query.text) {
            matchStage.$text = { $search: query.text };
        }

        // Author filter
        if (query.author) {
            matchStage['author.userId'] = query.author;
        }

        // Date range filter
        if (query.dateRange) {
            matchStage['timestamps.createdAt'] = {
                $gte: query.dateRange.start,
                $lte: query.dateRange.end
            };
        }

        // Status filter
        if (query.status && query.status.length > 0) {
            matchStage['metadata.status'] = { $in: query.status };
        }

        // Priority filter
        if (query.priority && query.priority.length > 0) {
            matchStage['metadata.priority'] = { $in: query.priority };
        }

        // Type filter
        if (query.type && query.type.length > 0) {
            matchStage['metadata.type'] = { $in: query.type };
        }

        // Tags filter
        if (query.tags && query.tags.length > 0) {
            matchStage.tags = { $in: query.tags };
        }

        // Cell ID filter
        if (query.cellId) {
            matchStage['anchor.cellId'] = query.cellId;
        }

        // Thread ID filter
        if (query.threadId) {
            matchStage.threadId = query.threadId;
        }

        pipeline.push({ $match: matchStage });

        // Sort stage
        if (query.sort) {
            const sortField = this._mapSortField(query.sort.field);
            const sortDirection = query.sort.direction === SortDirection.ASC ? 1 : -1;
            pipeline.push({ $sort: { [sortField]: sortDirection } });
        } else {
            // Default sort by creation time
            pipeline.push({ $sort: { 'timestamps.createdAt': -1 } });
        }

        // Pagination
        if (query.pagination) {
            const skip = query.pagination.page * query.pagination.pageSize;
            pipeline.push({ $skip: skip });
            pipeline.push({ $limit: query.pagination.pageSize });
        } else {
            // Default limit
            pipeline.push({ $limit: 100 });
        }

        return pipeline;
    }

    /**
     * Map sort field to MongoDB field.
     */
    private _mapSortField(field: SortField): string {
        switch (field) {
            case SortField.CREATED_AT:
                return 'timestamps.createdAt';
            case SortField.UPDATED_AT:
                return 'timestamps.updatedAt';
            case SortField.LAST_ACTIVITY:
                return 'timestamps.lastActivityAt';
            case SortField.AUTHOR:
                return 'author.displayName';
            case SortField.PRIORITY:
                return 'metadata.priority';
            case SortField.STATUS:
                return 'metadata.status';
            case SortField.RELEVANCE:
                return 'score';
            default:
                return 'timestamps.createdAt';
        }
    }

    /**
     * Build search facets.
     */
    private async _buildSearchFacets(query: ICommentSearchQuery, comments: IComment[]): Promise<ISearchFacets> {
        // This is a simplified facet implementation
        const facets: ISearchFacets = {
            authors: [],
            statuses: [],
            priorities: [],
            types: [],
            tags: [],
            dateRanges: []
        };

        // Count occurrences
        const authorCounts = new Map<string, number>();
        const statusCounts = new Map<string, number>();
        const priorityCounts = new Map<string, number>();
        const typeCounts = new Map<string, number>();
        const tagCounts = new Map<string, number>();

        comments.forEach(comment => {
            // Authors
            const authorKey = comment.author.displayName;
            authorCounts.set(authorKey, (authorCounts.get(authorKey) || 0) + 1);

            // Statuses
            statusCounts.set(comment.metadata.status, (statusCounts.get(comment.metadata.status) || 0) + 1);

            // Priorities
            priorityCounts.set(comment.metadata.priority, (priorityCounts.get(comment.metadata.priority) || 0) + 1);

            // Types
            typeCounts.set(comment.metadata.type, (typeCounts.get(comment.metadata.type) || 0) + 1);

            // Tags
            comment.tags.forEach(tag => {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            });
        });

        // Convert to facet format
        facets.authors = Array.from(authorCounts.entries()).map(([value, count]) => ({ value, count, label: value }));
        facets.statuses = Array.from(statusCounts.entries()).map(([value, count]) => ({ value, count, label: value }));
        facets.priorities = Array.from(priorityCounts.entries()).map(([value, count]) => ({ value, count, label: value }));
        facets.types = Array.from(typeCounts.entries()).map(([value, count]) => ({ value, count, label: value }));
        facets.tags = Array.from(tagCounts.entries()).map(([value, count]) => ({ value, count, label: value }));

        return facets;
    }

    /**
     * Build export filter.
     */
    private _buildExportFilter(options: any): any {
        const filter: any = {
            documentId: this._documentId
        };

        if (!options.includeDeleted) {
            filter['metadata.status'] = { $ne: CommentStatus.DELETED };
        }

        if (!options.includeResolved) {
            filter['metadata.status'] = { $ne: CommentStatus.RESOLVED };
        }

        if (options.cellIds && options.cellIds.length > 0) {
            filter['anchor.cellId'] = { $in: options.cellIds };
        }

        if (options.dateRange) {
            filter['timestamps.createdAt'] = {
                $gte: options.dateRange.start,
                $lte: options.dateRange.end
            };
        }

        return filter;
    }

    /**
     * Export comments to CSV format.
     */
    private _exportToCsv(comments: IComment[]): string {
        const headers = [
            'Comment ID',
            'Thread ID',
            'Parent ID',
            'Author',
            'Content',
            'Cell ID',
            'Status',
            'Priority',
            'Type',
            'Created At',
            'Updated At'
        ];

        const rows = comments.map(comment => [
            comment.commentId,
            comment.threadId,
            comment.parentId || '',
            comment.author.displayName,
            comment.content.text.replace(/"/g, '""'), // Escape quotes
            comment.anchor.cellId,
            comment.metadata.status,
            comment.metadata.priority,
            comment.metadata.type,
            comment.timestamps.createdAt.toISOString(),
            comment.timestamps.updatedAt.toISOString()
        ]);

        const csvContent = [headers, ...rows]
            .map(row => row.map(cell => `"${cell}"`).join(','))
            .join('\n');

        return csvContent;
    }

    /**
     * Export comments to Markdown format.
     */
    private _exportToMarkdown(comments: IComment[]): string {
        const groupedByCell = new Map<string, IComment[]>();

        // Group comments by cell
        comments.forEach(comment => {
            const cellId = comment.anchor.cellId;
            if (!groupedByCell.has(cellId)) {
                groupedByCell.set(cellId, []);
            }
            groupedByCell.get(cellId)!.push(comment);
        });

        // Generate markdown
        let markdown = '# Comment Export\n\n';
        markdown += `Exported on: ${new Date().toISOString()}\n\n`;

        for (const [cellId, cellComments] of groupedByCell.entries()) {
            markdown += `## Cell: ${cellId}\n\n`;

            cellComments.forEach(comment => {
                markdown += `### ${comment.author.displayName} - ${comment.timestamps.createdAt.toLocaleDateString()}\n\n`;
                markdown += `**Status:** ${comment.metadata.status} | **Priority:** ${comment.metadata.priority} | **Type:** ${comment.metadata.type}\n\n`;
                markdown += `${comment.content.text}\n\n`;
                
                if (comment.tags.length > 0) {
                    markdown += `**Tags:** ${comment.tags.join(', ')}\n\n`;
                }
                
                markdown += '---\n\n';
            });
        }

        return markdown;
    }

    /**
     * Parse CSV import data.
     */
    private _parseCsvImport(data: string): Partial<IComment>[] {
        const lines = data.split('\n').filter(line => line.trim());
        const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
        
        const comments: Partial<IComment>[] = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
            const comment: Partial<IComment> = {};

            headers.forEach((header, index) => {
                const value = values[index];
                
                switch (header.toLowerCase()) {
                    case 'comment id':
                        comment.commentId = value;
                        break;
                    case 'content':
                        comment.content = { text: value, format: CommentContentFormat.PLAIN_TEXT, mentions: [], links: [] };
                        break;
                    case 'cell id':
                        comment.anchor = { cellId: value, type: CommentAnchorType.CELL, context: { beforeText: '', anchorText: '', afterText: '', cellContentHash: '', contextLength: 0 } };
                        break;
                    // Add other field mappings as needed
                }
            });

            if (comment.commentId && comment.content && comment.anchor) {
                comments.push(comment);
            }
        }

        return comments;
    }

    /**
     * Process import comment.
     */
    private async _processImportComment(
        commentData: Partial<IComment>,
        options: any
    ): Promise<IComment | null> {
        // Validate required fields
        if (!commentData.commentId || !commentData.content || !commentData.anchor) {
            return null;
        }

        // Check if comment already exists
        if (!options.overwrite) {
            const existing = await this.getComment(commentData.commentId);
            if (existing) {
                return null; // Skip existing
            }
        }

        // Build complete comment
        const comment: IComment = {
            commentId: commentData.commentId,
            parentId: commentData.parentId || null,
            threadId: commentData.threadId || commentData.commentId,
            content: commentData.content,
            author: options.assignToCurrentUser ? this._currentUser! : (commentData.author || this._currentUser!),
            anchor: commentData.anchor,
            metadata: {
                status: commentData.metadata?.status || CommentStatus.ACTIVE,
                priority: commentData.metadata?.priority || CommentPriority.NORMAL,
                type: commentData.metadata?.type || CommentType.ANNOTATION,
                custom: {},
                version: 1
            },
            timestamps: {
                createdAt: commentData.timestamps?.createdAt || new Date(),
                updatedAt: new Date(),
                lastActivityAt: new Date()
            },
            visibility: commentData.visibility || this._getDefaultVisibility(),
            tags: commentData.tags || [],
            attachments: commentData.attachments || []
        };

        // Validate anchor if requested
        if (options.validateAnchors) {
            comment.anchor = this._validateAnchor(comment.anchor);
        }

        return comment;
    }

    /**
     * Delete comment permanently from MongoDB.
     */
    private async _deleteCommentPermanently(commentId: string): Promise<void> {
        await this._collections.comments.deleteOne({ commentId });
    }

    /**
     * Check if user can view comment.
     */
    private _canViewComment(comment: IComment): boolean {
        if (!this._currentUser) {
            return false;
        }

        const visibility = comment.visibility;
        
        switch (visibility.scope) {
            case VisibilityScope.PUBLIC:
                return true;
            case VisibilityScope.PRIVATE:
                return comment.author.userId === this._currentUser.userId;
            case VisibilityScope.ROLE_BASED:
                return visibility.allowedRoles.includes(this._currentUser.role);
            case VisibilityScope.CUSTOM:
                return visibility.allowedUsers.includes(this._currentUser.userId);
            default:
                return false;
        }
    }

    /**
     * Check if user can edit comment.
     */
    private _canEditComment(comment: IComment): boolean {
        if (!this._currentUser) {
            return false;
        }

        // Author can always edit their own comments
        if (comment.author.userId === this._currentUser.userId) {
            return true;
        }

        // Check role-based permissions
        if (this._currentUser.role === UserRole.ADMIN || this._currentUser.role === UserRole.OWNER) {
            return true;
        }

        // Check specific permissions
        return comment.visibility.permissions.canEdit;
    }

    /**
     * Check if user can delete comment.
     */
    private _canDeleteComment(comment: IComment): boolean {
        if (!this._currentUser) {
            return false;
        }

        // Author can delete their own comments
        if (comment.author.userId === this._currentUser.userId) {
            return true;
        }

        // Check role-based permissions
        if (this._currentUser.role === UserRole.ADMIN || this._currentUser.role === UserRole.OWNER) {
            return true;
        }

        // Check specific permissions
        return comment.visibility.permissions.canDelete;
    }

    /**
     * Check if user can resolve comment.
     */
    private _canResolveComment(comment: IComment): boolean {
        if (!this._currentUser) {
            return false;
        }

        // Check role-based permissions
        if (this._currentUser.role === UserRole.ADMIN || this._currentUser.role === UserRole.OWNER) {
            return true;
        }

        // Check specific permissions
        return comment.visibility.permissions.canResolve;
    }

    /**
     * Determine edit type from updates.
     */
    private _determineEditType(updates: any): CommentEditType {
        if (updates.content) {
            return CommentEditType.CONTENT;
        } else if (updates.metadata) {
            return CommentEditType.METADATA;
        } else if (updates.anchor) {
            return CommentEditType.ANCHOR;
        } else if (updates.tags) {
            return CommentEditType.TAGS;
        } else {
            return CommentEditType.CONTENT;
        }
    }

    /**
     * Extract previous value for edit history.
     */
    private _extractPreviousValue(comment: IComment, updates: any): JSONValue {
        if (updates.content) {
            return comment.content;
        } else if (updates.metadata) {
            return comment.metadata;
        } else if (updates.anchor) {
            return comment.anchor;
        } else if (updates.tags) {
            return comment.tags;
        } else {
            return null;
        }
    }

    /**
     * Check if update is significant enough for notifications.
     */
    private _isSignificantUpdate(updates: any): boolean {
        // Content changes are always significant
        if (updates.content) {
            return true;
        }

        // Status changes are significant
        if (updates.metadata?.status) {
            return true;
        }

        // Other updates are not significant for notifications
        return false;
    }

    /**
     * Handle cell deletion.
     */
    private async _handleCellDeletion(cellId: string): Promise<void> {
        try {
            // Find all comments for the deleted cell
            const comments = await this.getCommentsForCell(cellId, true);

            // Archive or delete comments as appropriate
            for (const comment of comments) {
                await this.updateComment(comment.commentId, {
                    metadata: {
                        ...comment.metadata,
                        status: CommentStatus.ARCHIVED
                    }
                });
            }

            console.log(`[CommentsSystem] Archived ${comments.length} comments for deleted cell ${cellId}`);

        } catch (error) {
            console.error(`[CommentsSystem] Error handling cell deletion for ${cellId}:`, error);
        }
    }

    /**
     * Track performance metric.
     */
    private _trackMetric(name: string, value: number): void {
        const current = this._metrics.get(name) || 0;
        this._metrics.set(name, current + value);
    }

    /**
     * Emit comment created event.
     */
    private _emitCommentCreated(comment: IComment): void {
        if (this._isDisposed) {
            return;
        }

        const event: ICommentsEvent = {
            type: CommentsEventType.COMMENT_CREATED,
            data: comment,
            timestamp: Date.now(),
            userId: this._currentUser?.userId,
            sessionId: this._sessionId,
            documentId: this._documentId
        };

        this._commentCreated.emit(event);
    }

    /**
     * Emit comment updated event.
     */
    private _emitCommentUpdated(comment: IComment): void {
        if (this._isDisposed) {
            return;
        }

        const event: ICommentsEvent = {
            type: CommentsEventType.COMMENT_UPDATED,
            data: comment,
            timestamp: Date.now(),
            userId: this._currentUser?.userId,
            sessionId: this._sessionId,
            documentId: this._documentId
        };

        this._commentUpdated.emit(event);
    }

    /**
     * Emit comment deleted event.
     */
    private _emitCommentDeleted(comment: IComment): void {
        if (this._isDisposed) {
            return;
        }

        const event: ICommentsEvent = {
            type: CommentsEventType.COMMENT_DELETED,
            data: comment,
            timestamp: Date.now(),
            userId: this._currentUser?.userId,
            sessionId: this._sessionId,
            documentId: this._documentId
        };

        this._commentDeleted.emit(event);
    }

    /**
     * Emit comment resolved event.
     */
    private _emitCommentResolved(comment: IComment): void {
        if (this._isDisposed) {
            return;
        }

        const event: ICommentsEvent = {
            type: CommentsEventType.COMMENT_RESOLVED,
            data: comment,
            timestamp: Date.now(),
            userId: this._currentUser?.userId,
            sessionId: this._sessionId,
            documentId: this._documentId
        };

        this._commentResolved.emit(event);
    }

    /**
     * Emit thread created event.
     */
    private _emitThreadCreated(thread: any): void {
        if (this._isDisposed) {
            return;
        }

        const event: ICommentsEvent = {
            type: CommentsEventType.THREAD_CREATED,
            data: thread,
            timestamp: Date.now(),
            userId: this._currentUser?.userId,
            sessionId: this._sessionId,
            documentId: this._documentId
        };

        this._threadCreated.emit(event);
    }

    /**
     * Emit thread updated event.
     */
    private _emitThreadUpdated(thread: any): void {
        if (this._isDisposed) {
            return;
        }

        const event: ICommentsEvent = {
            type: CommentsEventType.THREAD_UPDATED,
            data: thread,
            timestamp: Date.now(),
            userId: this._currentUser?.userId,
            sessionId: this._sessionId,
            documentId: this._documentId
        };

        this._threadUpdated.emit(event);
    }

    /**
     * Emit notification sent event.
     */
    private _emitNotificationSent(notification: ICommentNotification): void {
        if (this._isDisposed) {
            return;
        }

        const event: ICommentsEvent = {
            type: CommentsEventType.NOTIFICATION_SENT,
            data: notification,
            timestamp: Date.now(),
            userId: this._currentUser?.userId,
            sessionId: this._sessionId,
            documentId: this._documentId
        };

        this._notificationSent.emit(event);
    }

    /**
     * Emit error event.
     */
    private _emitError(error: Error): void {
        if (this._isDisposed) {
            return;
        }

        console.error('[CommentsSystem] Error:', error);
        this._errorOccurred.emit(error);
    }

    /**
     * Ensure system is initialized.
     */
    private _ensureInitialized(): void {
        if (!this._isInitialized) {
            throw new Error('CommentsSystem not initialized. Call initialize() first.');
        }
        if (this._isDisposed) {
            throw new Error('CommentsSystem has been disposed');
        }
    }
}

/**
 * Factory function to create a CommentsSystem with sensible defaults.
 * 
 * @param config - Comments system configuration
 * @param documentId - Document identifier
 * @param sessionId - Session identifier
 * @param collaborationProvider - Collaboration provider
 * @param awareness - Awareness system
 * @returns New CommentsSystem instance
 */
export function createCommentsSystem(
    config: Partial<ICommentsConfig>,
    documentId: string,
    sessionId: string,
    collaborationProvider: ICollaborationProvider,
    awareness: CollaborativeAwareness
): CommentsSystem {
    return new CommentsSystem(config, documentId, sessionId, collaborationProvider, awareness);
}

/**
 * Utility functions for comment management.
 */
export namespace CommentsUtils {
    /**
     * Validate comment configuration.
     */
    export function validateConfig(config: Partial<ICommentsConfig>): string[] {
        const errors: string[] = [];

        if (config.mongodb?.connectionUrl && !config.mongodb.connectionUrl.startsWith('mongodb://')) {
            errors.push('Invalid MongoDB connection URL');
        }

        if (config.websocket?.endpoint && !config.websocket.endpoint.startsWith('/')) {
            errors.push('WebSocket endpoint must start with /');
        }

        if (config.security?.rateLimiting?.commentsPerMinute && config.security.rateLimiting.commentsPerMinute < 1) {
            errors.push('Rate limiting must allow at least 1 comment per minute');
        }

        return errors;
    }

    /**
     * Generate anchor context for stable positioning.
     */
    export function generateAnchorContext(
        cellContent: string,
        lineNumber: number,
        characterOffset: number,
        contextLength = 50
    ): IAnchorContext {
        const lines = cellContent.split('\n');
        const targetLine = lines[lineNumber] || '';
        
        const beforeText = targetLine.substring(Math.max(0, characterOffset - contextLength), characterOffset);
        const anchorText = targetLine.substring(characterOffset, characterOffset + 1);
        const afterText = targetLine.substring(characterOffset + 1, characterOffset + 1 + contextLength);
        
        // Simple hash function for content
        const cellContentHash = btoa(cellContent).slice(0, 16);

        return {
            beforeText,
            anchorText,
            afterText,
            cellContentHash,
            contextLength
        };
    }

    /**
     * Find anchor position from context.
     */
    export function findAnchorFromContext(
        cellContent: string,
        context: IAnchorContext
    ): { lineNumber: number; characterOffset: number } | null {
        const lines = cellContent.split('\n');
        
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            const searchText = context.beforeText + context.anchorText + context.afterText;
            const position = line.indexOf(searchText);
            
            if (position !== -1) {
                return {
                    lineNumber: lineIndex,
                    characterOffset: position + context.beforeText.length
                };
            }
        }

        return null;
    }

    /**
     * Sanitize comment text for security.
     */
    export function sanitizeText(text: string, maxLength = 10000): string {
        return text
            .trim()
            .substring(0, maxLength)
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '');
    }

    /**
     * Extract mentions from comment text.
     */
    export function extractMentions(text: string): ICommentMention[] {
        const mentions: ICommentMention[] = [];
        const mentionRegex = /@(\w+)/g;
        let match;

        while ((match = mentionRegex.exec(text)) !== null) {
            mentions.push({
                userId: match[1], // This would need user ID lookup
                displayName: match[1],
                offset: match.index,
                length: match[0].length,
                type: MentionType.USER
            });
        }

        return mentions;
    }

    /**
     * Extract links from comment text.
     */
    export function extractLinks(text: string): ICommentLink[] {
        const links: ICommentLink[] = [];
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        let match;

        while ((match = urlRegex.exec(text)) !== null) {
            links.push({
                url: match[0],
                title: match[0],
                offset: match.index,
                length: match[0].length,
                type: LinkType.EXTERNAL
            });
        }

        return links;
    }

    /**
     * Format comment content for display.
     */
    export function formatContentForDisplay(content: ICommentContent): string {
        switch (content.format) {
            case CommentContentFormat.MARKDOWN:
                // Would integrate with a markdown parser
                return content.markdown || content.text;
            case CommentContentFormat.HTML:
                return content.html || content.text;
            default:
                return content.text;
        }
    }

    /**
     * Check if comment is expired.
     */
    export function isCommentExpired(comment: IComment): boolean {
        if (!comment.timestamps.scheduledDeletionAt) {
            return false;
        }
        return new Date() > comment.timestamps.scheduledDeletionAt;
    }

    /**
     * Calculate comment thread depth.
     */
    export function calculateThreadDepth(comments: IComment[]): number {
        const parentMap = new Map<string, string>();
        comments.forEach(comment => {
            if (comment.parentId) {
                parentMap.set(comment.commentId, comment.parentId);
            }
        });

        let maxDepth = 0;
        
        for (const comment of comments) {
            let depth = 0;
            let current = comment.commentId;
            
            while (parentMap.has(current)) {
                depth++;
                current = parentMap.get(current)!;
                
                // Prevent infinite loops
                if (depth > 100) {
                    break;
                }
            }
            
            maxDepth = Math.max(maxDepth, depth);
        }

        return maxDepth;
    }
}

/**
 * Export all comment-related types and interfaces.
 */
export type {
    IComment,
    ICommentContent,
    ICommentAuthor,
    ICommentAnchor,
    ICommentMetadata,
    ICommentTimestamps,
    ICommentVisibility,
    ICommentPermissions,
    ICommentAttachment,
    ICommentThread,
    ICommentNotification,
    ICommentSearchQuery,
    ICommentSearchResults,
    ICommentsConfig,
    ICommentsEvent
};