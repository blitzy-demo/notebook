/**
 * JSDoc plugin for Jupyter Notebook with collaboration-specific documentation support
 * 
 * This plugin extends the base JSDoc functionality to handle collaboration features
 * including Yjs components, TypeScript interfaces, and collaborative API documentation.
 * 
 * @version 7.2.0
 * @since 7.2.0
 */

/**
 * Collaboration-specific patterns for special handling
 */
const COLLABORATION_PATTERNS = {
  // Yjs-related components and providers
  yjs: /^(Yjs|Y\.)/,
  // Collaboration UI components
  collabUI: /^(Collaboration|Awareness|Comment|Permission|Lock)/,
  // Collaboration services and handlers
  collabService: /^(Collab|CollaborationService|WebSocketHandler)/,
  // Internal collaboration APIs (should be documented but marked as internal)
  internalAPI: /^_collab|^_yjs|^_awareness/,
  // TypeScript interfaces for collaboration
  interfaces: /^I[A-Z].*Collab|^I[A-Z].*Awareness|^I[A-Z].*Yjs/
};

/**
 * Collaboration-specific JSDoc tags that should be recognized
 */
const COLLABORATION_TAGS = [
  'collaboration',
  'yjs',
  'awareness',
  'crdt',
  'realtime',
  'permissions',
  'locking',
  'comments',
  'sync',
  'collaborative'
];

exports.handlers = {
  /**
   * Handler for processing new doclets with collaboration-specific logic
   * 
   * @param {Object} e - Event object containing the doclet
   * @param {Object} e.doclet - The newly created doclet to process
   */
  newDoclet: function (e) {
    // e.doclet will refer to the newly created doclet
    // you can read and modify properties of that doclet if you wish
    if (typeof e.doclet.name === 'string') {
      
      // Handle collaboration-specific internal APIs
      if (COLLABORATION_PATTERNS.internalAPI.test(e.doclet.name)) {
        // Mark as internal but still document (unlike regular private methods)
        e.doclet.tags = e.doclet.tags || [];
        e.doclet.tags.push({
          originalTitle: 'internal',
          title: 'internal',
          text: 'Internal collaboration API - subject to change'
        });
        
        // Add collaboration namespace
        if (e.doclet.memberof && e.doclet.memberof !== '<anonymous>') {
          e.doclet.memberof = e.doclet.memberof + '.internal';
        }
        
        console.log(
          'Internal collaboration API "' + e.doclet.longname + '" documented with internal tag.'
        );
      }
      // Handle standard private methods (existing logic)
      else if (e.doclet.name[0] === '_' && !COLLABORATION_PATTERNS.internalAPI.test(e.doclet.name)) {
        console.log(
          'Private method "' + e.doclet.longname + '" not documented.'
        );
        e.doclet.memberof = '<anonymous>';
      }
      
      // Process collaboration-specific components
      if (isCollaborationComponent(e.doclet)) {
        processCollaborationComponent(e.doclet);
      }
      
      // Process TypeScript interfaces
      if (isCollaborationInterface(e.doclet)) {
        processCollaborationInterface(e.doclet);
      }
      
      // Enhance collaboration API endpoints
      if (isCollaborationEndpoint(e.doclet)) {
        processCollaborationEndpoint(e.doclet);
      }
    }
  },

  /**
   * Handler for processing JSDoc comments before parsing
   * 
   * @param {Object} e - Event object containing comment data
   * @param {string} e.comment - The comment text
   * @param {string} e.filename - The source filename
   */
  beforeParse: function(e) {
    // Process collaboration-specific comment patterns
    if (e.filename && isCollaborationFile(e.filename)) {
      // Add collaboration context to comments
      e.source = enhanceCollaborationComments(e.source);
    }
  }
};

/**
 * Check if a doclet represents a collaboration component
 * 
 * @param {Object} doclet - The doclet to check
 * @returns {boolean} True if this is a collaboration component
 */
function isCollaborationComponent(doclet) {
  return doclet.name && (
    COLLABORATION_PATTERNS.yjs.test(doclet.name) ||
    COLLABORATION_PATTERNS.collabUI.test(doclet.name) ||
    COLLABORATION_PATTERNS.collabService.test(doclet.name)
  );
}

/**
 * Check if a doclet represents a collaboration TypeScript interface
 * 
 * @param {Object} doclet - The doclet to check  
 * @returns {boolean} True if this is a collaboration interface
 */
function isCollaborationInterface(doclet) {
  return doclet.name && (
    COLLABORATION_PATTERNS.interfaces.test(doclet.name) ||
    (doclet.kind === 'interface' && doclet.comment && 
     COLLABORATION_TAGS.some(tag => doclet.comment.includes('@' + tag)))
  );
}

/**
 * Check if a doclet represents a collaboration API endpoint
 * 
 * @param {Object} doclet - The doclet to check
 * @returns {boolean} True if this is a collaboration endpoint
 */
function isCollaborationEndpoint(doclet) {
  return doclet.name && (
    doclet.name.includes('Handler') ||
    doclet.name.includes('Endpoint') ||
    doclet.name.includes('API')
  ) && (
    doclet.comment && 
    COLLABORATION_TAGS.some(tag => doclet.comment.includes('@' + tag))
  );
}

/**
 * Check if a file contains collaboration code
 * 
 * @param {string} filename - The filename to check
 * @returns {boolean} True if this is a collaboration file
 */
function isCollaborationFile(filename) {
  return filename && (
    filename.includes('/collab/') ||
    filename.includes('/collaboration/') ||
    filename.includes('yjs') ||
    filename.includes('awareness') ||
    filename.includes('collaborative')
  );
}

/**
 * Process collaboration component doclets with special handling
 * 
 * @param {Object} doclet - The collaboration component doclet
 */
function processCollaborationComponent(doclet) {
  // Ensure collaboration components have proper tags
  doclet.tags = doclet.tags || [];
  
  // Add collaboration tag if not already present
  if (!doclet.tags.some(tag => tag.title === 'collaboration')) {
    doclet.tags.push({
      originalTitle: 'collaboration',
      title: 'collaboration',
      text: 'Part of the real-time collaboration system'
    });
  }
  
  // Add version information for collaboration features
  if (!doclet.tags.some(tag => tag.title === 'since')) {
    doclet.tags.push({
      originalTitle: 'since',
      title: 'since',
      text: '7.2.0'
    });
  }
  
  // Add stability warnings for new collaboration features
  if (COLLABORATION_PATTERNS.yjs.test(doclet.name)) {
    doclet.tags.push({
      originalTitle: 'experimental',
      title: 'experimental',
      text: 'This collaboration feature is under active development'
    });
  }
  
  console.log(
    'Collaboration component "' + doclet.longname + '" processed with collaboration tags.'
  );
}

/**
 * Process collaboration interface doclets with TypeScript-specific handling
 * 
 * @param {Object} doclet - The collaboration interface doclet
 */
function processCollaborationInterface(doclet) {
  // Ensure interfaces have proper TypeScript documentation
  doclet.tags = doclet.tags || [];
  
  // Add interface tag
  if (!doclet.tags.some(tag => tag.title === 'interface')) {
    doclet.tags.push({
      originalTitle: 'interface',
      title: 'interface',
      text: 'TypeScript interface for collaboration features'
    });
  }
  
  // Add namespace information
  if (doclet.memberof) {
    doclet.tags.push({
      originalTitle: 'namespace',
      title: 'namespace',
      text: doclet.memberof
    });
  }
  
  console.log(
    'Collaboration interface "' + doclet.longname + '" processed with TypeScript support.'
  );
}

/**
 * Process collaboration API endpoint doclets
 * 
 * @param {Object} doclet - The collaboration endpoint doclet
 */
function processCollaborationEndpoint(doclet) {
  doclet.tags = doclet.tags || [];
  
  // Add API endpoint tag
  doclet.tags.push({
    originalTitle: 'api',
    title: 'api',
    text: 'Collaboration API endpoint'
  });
  
  // Add WebSocket information if applicable
  if (doclet.name.includes('WebSocket') || doclet.name.includes('WS')) {
    doclet.tags.push({
      originalTitle: 'websocket',
      title: 'websocket',
      text: 'Uses WebSocket for real-time communication'
    });
  }
  
  console.log(
    'Collaboration endpoint "' + doclet.longname + '" processed with API documentation.'
  );
}

/**
 * Enhance source code comments with collaboration context
 * 
 * @param {string} source - The source code to enhance
 * @returns {string} Enhanced source code
 */
function enhanceCollaborationComments(source) {
  // Add collaboration context to class and function comments
  return source.replace(
    /(\/\*\*[\s\S]*?\*\/)\s*(class|function|interface)\s+([A-Z]\w*(?:Collab|Yjs|Awareness)\w*)/g,
    function(match, comment, type, name) {
      // Only enhance if collaboration tag is not already present
      if (!comment.includes('@collaboration')) {
        const enhancedComment = comment.replace(
          /(\*\/)/,
          ' * @collaboration Part of the real-time collaboration system\n * @since 7.2.0\n$1'
        );
        return enhancedComment + '\n' + type + ' ' + name;
      }
      return match;
    }
  );
}
