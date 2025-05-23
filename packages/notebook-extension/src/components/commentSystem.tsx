import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ICommentService } from '@jupyter-notebook/application';
import { NotebookPanel } from '@jupyterlab/notebook';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from 'rehype-sanitize';

/**
 * Interface for comment thread props
 */
interface ICommentThreadProps {
  comment: ICommentService.IComment;
  documentPath: string;
  commentService: ICommentService;
  translator: ITranslator;
  onUpdate?: () => void;
}

/**
 * Interface for comment form props
 */
interface ICommentFormProps {
  documentPath: string;
  cellId: string;
  commentService: ICommentService;
  translator: ITranslator;
  onCommentAdded?: () => void;
  range?: { start: number; end: number };
  initialContent?: string;
  placeholder?: string;
  buttonText?: string;
}

/**
 * Interface for comment system props
 */
interface ICommentSystemProps {
  notebook: NotebookPanel;
  commentService: ICommentService;
  translator?: ITranslator;
}

/**
 * Interface for comment list props
 */
interface ICommentListProps {
  documentPath: string;
  commentService: ICommentService;
  translator: ITranslator;
  filter?: 'all' | 'resolved' | 'unresolved';
  cellId?: string;
}

/**
 * A component to render a single comment reply
 */
const CommentReply: React.FC<{
  reply: ICommentService.IReply;
  documentPath: string;
  commentId: string;
  commentService: ICommentService;
  translator: ITranslator;
  onUpdate?: () => void;
}> = ({ reply, documentPath, commentId, commentService, translator, onUpdate }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState(reply.content);
  const trans = translator.load('notebook');

  const handleSaveEdit = useCallback(async () => {
    try {
      await commentService.updateReply(documentPath, commentId, reply.id!, {
        content,
        updatedAt: Date.now()
      });
      setIsEditing(false);
      if (onUpdate) onUpdate();
    } catch (error) {
      console.error('Failed to update reply:', error);
    }
  }, [commentService, documentPath, commentId, reply.id, content, onUpdate]);

  const handleDelete = useCallback(async () => {
    try {
      await commentService.deleteReply(documentPath, commentId, reply.id!);
      if (onUpdate) onUpdate();
    } catch (error) {
      console.error('Failed to delete reply:', error);
    }
  }, [commentService, documentPath, commentId, reply.id, onUpdate]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="jp-CommentSystem-reply">
      <div className="jp-CommentSystem-replyHeader">
        <div className="jp-CommentSystem-replyAuthor">
          <span className="jp-CommentSystem-userName">{reply.userName}</span>
          <span className="jp-CommentSystem-timestamp">
            {formatDate(reply.createdAt)}
            {reply.updatedAt && reply.updatedAt !== reply.createdAt && 
              ` (${trans.__('edited')} ${formatDate(reply.updatedAt)})`}
          </span>
        </div>
        <div className="jp-CommentSystem-replyActions">
          {isEditing ? (
            <>
              <button 
                className="jp-CommentSystem-actionButton jp-CommentSystem-saveButton"
                onClick={handleSaveEdit}
                aria-label={trans.__('Save')}
              >
                {trans.__('Save')}
              </button>
              <button 
                className="jp-CommentSystem-actionButton jp-CommentSystem-cancelButton"
                onClick={() => {
                  setContent(reply.content);
                  setIsEditing(false);
                }}
                aria-label={trans.__('Cancel')}
              >
                {trans.__('Cancel')}
              </button>
            </>
          ) : (
            <>
              <button 
                className="jp-CommentSystem-actionButton jp-CommentSystem-editButton"
                onClick={() => setIsEditing(true)}
                aria-label={trans.__('Edit')}
              >
                {trans.__('Edit')}
              </button>
              <button 
                className="jp-CommentSystem-actionButton jp-CommentSystem-deleteButton"
                onClick={handleDelete}
                aria-label={trans.__('Delete')}
              >
                {trans.__('Delete')}
              </button>
            </>
          )}
        </div>
      </div>
      {isEditing ? (
        <MDEditor
          value={content}
          onChange={(value) => setContent(value || '')}
          preview="edit"
          height={100}
          previewOptions={{
            rehypePlugins: [[rehypeSanitize]]
          }}
        />
      ) : (
        <div className="jp-CommentSystem-replyContent">
          <MDEditor.Markdown source={reply.content} />
        </div>
      )}
    </div>
  );
};

/**
 * A component to render a comment thread with its replies
 */
const CommentThread: React.FC<ICommentThreadProps> = ({ 
  comment, 
  documentPath, 
  commentService, 
  translator,
  onUpdate 
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [isReplying, setIsReplying] = useState(false);
  const [content, setContent] = useState(comment.content);
  const [replyContent, setReplyContent] = useState('');
  const trans = translator.load('notebook');

  const handleSaveEdit = useCallback(async () => {
    try {
      await commentService.updateComment(documentPath, comment.id!, {
        content,
        updatedAt: Date.now()
      });
      setIsEditing(false);
      if (onUpdate) onUpdate();
    } catch (error) {
      console.error('Failed to update comment:', error);
    }
  }, [commentService, documentPath, comment.id, content, onUpdate]);

  const handleDelete = useCallback(async () => {
    try {
      await commentService.deleteComment(documentPath, comment.id!);
      if (onUpdate) onUpdate();
    } catch (error) {
      console.error('Failed to delete comment:', error);
    }
  }, [commentService, documentPath, comment.id, onUpdate]);

  const handleResolve = useCallback(async () => {
    try {
      await commentService.resolveComment(documentPath, comment.id!, !comment.resolved);
      if (onUpdate) onUpdate();
    } catch (error) {
      console.error('Failed to resolve comment:', error);
    }
  }, [commentService, documentPath, comment.id, comment.resolved, onUpdate]);

  const handleAddReply = useCallback(async () => {
    if (!replyContent.trim()) return;
    
    try {
      await commentService.addReply(documentPath, comment.id!, {
        content: replyContent,
        userId: 'current-user', // This would be replaced with the actual user ID
        userName: 'Current User', // This would be replaced with the actual user name
        createdAt: Date.now()
      });
      setReplyContent('');
      setIsReplying(false);
      if (onUpdate) onUpdate();
    } catch (error) {
      console.error('Failed to add reply:', error);
    }
  }, [commentService, documentPath, comment.id, replyContent, onUpdate]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className={`jp-CommentSystem-thread ${comment.resolved ? 'jp-CommentSystem-resolved' : ''}`}>
      <div className="jp-CommentSystem-commentHeader">
        <div className="jp-CommentSystem-commentAuthor">
          <span className="jp-CommentSystem-userName">{comment.userName}</span>
          <span className="jp-CommentSystem-timestamp">
            {formatDate(comment.createdAt)}
            {comment.updatedAt && comment.updatedAt !== comment.createdAt && 
              ` (${trans.__('edited')} ${formatDate(comment.updatedAt)})`}
          </span>
          {comment.resolved && (
            <span className="jp-CommentSystem-resolvedBadge">
              {trans.__('Resolved')}
              {comment.resolvedBy && ` ${trans.__('by')} ${comment.resolvedBy}`}
              {comment.resolvedAt && ` ${formatDate(comment.resolvedAt)}`}
            </span>
          )}
        </div>
        <div className="jp-CommentSystem-commentActions">
          {isEditing ? (
            <>
              <button 
                className="jp-CommentSystem-actionButton jp-CommentSystem-saveButton"
                onClick={handleSaveEdit}
                aria-label={trans.__('Save')}
              >
                {trans.__('Save')}
              </button>
              <button 
                className="jp-CommentSystem-actionButton jp-CommentSystem-cancelButton"
                onClick={() => {
                  setContent(comment.content);
                  setIsEditing(false);
                }}
                aria-label={trans.__('Cancel')}
              >
                {trans.__('Cancel')}
              </button>
            </>
          ) : (
            <>
              <button 
                className="jp-CommentSystem-actionButton jp-CommentSystem-replyButton"
                onClick={() => setIsReplying(!isReplying)}
                aria-label={trans.__('Reply')}
              >
                {trans.__('Reply')}
              </button>
              <button 
                className="jp-CommentSystem-actionButton jp-CommentSystem-editButton"
                onClick={() => setIsEditing(true)}
                aria-label={trans.__('Edit')}
              >
                {trans.__('Edit')}
              </button>
              <button 
                className="jp-CommentSystem-actionButton jp-CommentSystem-deleteButton"
                onClick={handleDelete}
                aria-label={trans.__('Delete')}
              >
                {trans.__('Delete')}
              </button>
              <button 
                className={`jp-CommentSystem-actionButton ${comment.resolved ? 'jp-CommentSystem-unresolveButton' : 'jp-CommentSystem-resolveButton'}`}
                onClick={handleResolve}
                aria-label={comment.resolved ? trans.__('Unresolve') : trans.__('Resolve')}
              >
                {comment.resolved ? trans.__('Unresolve') : trans.__('Resolve')}
              </button>
            </>
          )}
        </div>
      </div>
      
      {isEditing ? (
        <MDEditor
          value={content}
          onChange={(value) => setContent(value || '')}
          preview="edit"
          height={150}
          previewOptions={{
            rehypePlugins: [[rehypeSanitize]]
          }}
        />
      ) : (
        <div className="jp-CommentSystem-commentContent">
          <MDEditor.Markdown source={comment.content} />
        </div>
      )}
      
      {comment.range && (
        <div className="jp-CommentSystem-commentRange">
          <span className="jp-CommentSystem-rangeLabel">{trans.__('Selection:')}</span>
          <span className="jp-CommentSystem-rangeValue">
            {trans.__('Characters %1 to %2', comment.range.start.toString(), comment.range.end.toString())}
          </span>
        </div>
      )}
      
      {comment.replies && comment.replies.length > 0 && (
        <div className="jp-CommentSystem-replies">
          {comment.replies.map((reply) => (
            <CommentReply
              key={reply.id}
              reply={reply}
              documentPath={documentPath}
              commentId={comment.id!}
              commentService={commentService}
              translator={translator}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}
      
      {isReplying && (
        <div className="jp-CommentSystem-replyForm">
          <MDEditor
            value={replyContent}
            onChange={(value) => setReplyContent(value || '')}
            preview="edit"
            height={100}
            previewOptions={{
              rehypePlugins: [[rehypeSanitize]]
            }}
          />
          <div className="jp-CommentSystem-replyFormActions">
            <button 
              className="jp-CommentSystem-actionButton jp-CommentSystem-submitButton"
              onClick={handleAddReply}
              disabled={!replyContent.trim()}
              aria-label={trans.__('Submit Reply')}
            >
              {trans.__('Submit Reply')}
            </button>
            <button 
              className="jp-CommentSystem-actionButton jp-CommentSystem-cancelButton"
              onClick={() => {
                setReplyContent('');
                setIsReplying(false);
              }}
              aria-label={trans.__('Cancel')}
            >
              {trans.__('Cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * A component to render a form for adding new comments
 */
const CommentForm: React.FC<ICommentFormProps> = ({
  documentPath,
  cellId,
  commentService,
  translator,
  onCommentAdded,
  range,
  initialContent = '',
  placeholder,
  buttonText
}) => {
  const [content, setContent] = useState(initialContent);
  const trans = translator.load('notebook');

  const handleSubmit = useCallback(async () => {
    if (!content.trim()) return;
    
    try {
      await commentService.addComment(documentPath, {
        cellId,
        content,
        userId: 'current-user', // This would be replaced with the actual user ID
        userName: 'Current User', // This would be replaced with the actual user name
        createdAt: Date.now(),
        range
      });
      setContent('');
      if (onCommentAdded) onCommentAdded();
    } catch (error) {
      console.error('Failed to add comment:', error);
    }
  }, [commentService, documentPath, cellId, content, range, onCommentAdded]);

  return (
    <div className="jp-CommentSystem-form">
      <MDEditor
        value={content}
        onChange={(value) => setContent(value || '')}
        preview="edit"
        height={150}
        placeholder={placeholder || trans.__('Add a comment...')}
        previewOptions={{
          rehypePlugins: [[rehypeSanitize]]
        }}
      />
      <div className="jp-CommentSystem-formActions">
        <button 
          className="jp-CommentSystem-actionButton jp-CommentSystem-submitButton"
          onClick={handleSubmit}
          disabled={!content.trim()}
          aria-label={buttonText || trans.__('Submit Comment')}
        >
          {buttonText || trans.__('Submit Comment')}
        </button>
      </div>
    </div>
  );
};

/**
 * A component to render a list of comments
 */
const CommentList: React.FC<ICommentListProps> = ({ 
  documentPath, 
  commentService, 
  translator,
  filter = 'all',
  cellId
}) => {
  const [comments, setComments] = useState<ICommentService.IComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const trans = translator.load('notebook');

  const fetchComments = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      let fetchedComments: ICommentService.IComment[];
      
      if (cellId) {
        fetchedComments = await commentService.getCellComments(documentPath, cellId);
      } else {
        fetchedComments = await commentService.getComments(documentPath);
      }
      
      setComments(fetchedComments);
    } catch (err) {
      console.error('Failed to fetch comments:', err);
      setError(trans.__('Failed to load comments. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, [commentService, documentPath, cellId, trans]);

  useEffect(() => {
    fetchComments();
    
    // Subscribe to comment changes
    const subscription = commentService.commentsChanged.connect((_, changeEvent) => {
      if (changeEvent.documentPath === documentPath) {
        fetchComments();
      }
    });
    
    return () => {
      subscription.disconnect();
    };
  }, [commentService, documentPath, fetchComments]);

  const filteredComments = useMemo(() => {
    if (filter === 'all') return comments;
    if (filter === 'resolved') return comments.filter(comment => comment.resolved);
    if (filter === 'unresolved') return comments.filter(comment => !comment.resolved);
    return comments;
  }, [comments, filter]);

  if (loading) {
    return <div className="jp-CommentSystem-loading">{trans.__('Loading comments...')}</div>;
  }

  if (error) {
    return (
      <div className="jp-CommentSystem-error">
        <p>{error}</p>
        <button 
          className="jp-CommentSystem-actionButton jp-CommentSystem-retryButton"
          onClick={fetchComments}
          aria-label={trans.__('Retry')}
        >
          {trans.__('Retry')}
        </button>
      </div>
    );
  }

  if (filteredComments.length === 0) {
    return (
      <div className="jp-CommentSystem-empty">
        {filter === 'all' && trans.__('No comments yet.')}
        {filter === 'resolved' && trans.__('No resolved comments.')}
        {filter === 'unresolved' && trans.__('No unresolved comments.')}
      </div>
    );
  }

  return (
    <div className="jp-CommentSystem-list">
      {filteredComments.map(comment => (
        <CommentThread
          key={comment.id}
          comment={comment}
          documentPath={documentPath}
          commentService={commentService}
          translator={translator}
          onUpdate={fetchComments}
        />
      ))}
    </div>
  );
};

/**
 * The main comment system component
 */
const CommentSystem: React.FC<ICommentSystemProps> = ({ 
  notebook, 
  commentService, 
  translator = nullTranslator 
}) => {
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'resolved' | 'unresolved'>('all');
  const [showAddComment, setShowAddComment] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const trans = translator.load('notebook');

  useEffect(() => {
    if (!notebook) return;

    const onActiveCellChanged = () => {
      const cell = notebook.content.activeCell;
      if (cell) {
        setActiveCell(cell.model.id);
      } else {
        setActiveCell(null);
      }
    };

    // Set initial active cell
    onActiveCellChanged();

    // Subscribe to active cell changes
    notebook.content.activeCellChanged.connect(onActiveCellChanged);

    return () => {
      notebook.content.activeCellChanged.disconnect(onActiveCellChanged);
    };
  }, [notebook]);

  const documentPath = useMemo(() => {
    return notebook?.context?.path || '';
  }, [notebook]);

  if (!documentPath) {
    return <div className="jp-CommentSystem-error">{trans.__('No document path available.')}</div>;
  }

  return (
    <div className="jp-CommentSystem">
      <div className="jp-CommentSystem-header">
        <h3 className="jp-CommentSystem-title">{trans.__('Comments')}</h3>
        <div className="jp-CommentSystem-controls">
          <div className="jp-CommentSystem-filter">
            <select 
              value={filter}
              onChange={(e) => setFilter(e.target.value as any)}
              aria-label={trans.__('Filter comments')}
            >
              <option value="all">{trans.__('All Comments')}</option>
              <option value="resolved">{trans.__('Resolved')}</option>
              <option value="unresolved">{trans.__('Unresolved')}</option>
            </select>
          </div>
          <div className="jp-CommentSystem-search">
            <input
              type="text"
              placeholder={trans.__('Search comments...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label={trans.__('Search comments')}
            />
          </div>
          <button
            className="jp-CommentSystem-actionButton jp-CommentSystem-addButton"
            onClick={() => setShowAddComment(!showAddComment)}
            aria-label={trans.__('Add Comment')}
          >
            {showAddComment ? trans.__('Cancel') : trans.__('Add Comment')}
          </button>
        </div>
      </div>

      {showAddComment && activeCell && (
        <div className="jp-CommentSystem-addCommentSection">
          <h4 className="jp-CommentSystem-sectionTitle">{trans.__('New Comment')}</h4>
          <CommentForm
            documentPath={documentPath}
            cellId={activeCell}
            commentService={commentService}
            translator={translator}
            onCommentAdded={() => setShowAddComment(false)}
          />
        </div>
      )}

      <div className="jp-CommentSystem-content">
        <CommentList
          documentPath={documentPath}
          commentService={commentService}
          translator={translator}
          filter={filter}
        />
      </div>
    </div>
  );
};

/**
 * A namespace for CommentSystem statics.
 */
export namespace CommentSystemComponent {
  /**
   * Create a new CommentSystem widget.
   */
  export const create = ({
    notebook,
    commentService,
    translator = nullTranslator
  }: {
    notebook: NotebookPanel;
    commentService: ICommentService;
    translator?: ITranslator;
  }): ReactWidget => {
    return ReactWidget.create(
      <CommentSystem 
        notebook={notebook} 
        commentService={commentService} 
        translator={translator} 
      />
    );
  };
}