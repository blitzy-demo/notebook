// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { JupyterFrontEnd } from '@jupyterlab/application';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { find } from '@lumino/algorithm';
import { JSONExt, PromiseDelegate, Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import {
  BoxLayout,
  FocusTracker,
  Panel,
  SplitPanel,
  TabPanel,
  Widget,
} from '@lumino/widgets';
import { PanelHandler, SidePanelHandler } from './panelhandler';
import { TabPanelSvg } from '@jupyterlab/ui-components';

// Collaboration component imports
import {
  ICollaborationProvider,
  AwarenessService,
  LockService,
  CommentService,
  HistoryManager,
  PermissionsManager
} from './tokens';

/**
 * The Jupyter Notebook application shell token.
 */
export const INotebookShell = new Token<INotebookShell>(
  '@jupyter-notebook/application:INotebookShell'
);

/**
 * The Jupyter Notebook application shell interface.
 */
export interface INotebookShell extends NotebookShell {}

/**
 * The namespace for INotebookShell type information.
 */
export namespace INotebookShell {
  /**
   * The areas of the application shell where widgets can reside.
   */
  export type Area = 'main' | 'top' | 'menu' | 'left' | 'right' | 'down' | 'collaboration';

  /**
   * Widget position
   */
  export interface IWidgetPosition {
    /**
     * Widget area
     */
    area?: Area;
    /**
     * Widget opening options
     */
    options?: DocumentRegistry.IOpenOptions;
  }

  /**
   * Mapping of widget type identifier and their user customized position
   */
  export interface IUserLayout {
    /**
     * Widget customized position
     */
    [k: string]: IWidgetPosition;
  }
}

/**
 * The default rank for ranked panels.
 */
const DEFAULT_RANK = 900;

/**
 * The application shell.
 */
export class NotebookShell extends Widget implements JupyterFrontEnd.IShell {
  constructor() {
    super();
    this.id = 'main';
    this._userLayout = {};

    this._topHandler = new PanelHandler();
    this._menuHandler = new PanelHandler();
    this._leftHandler = new SidePanelHandler('left');
    this._rightHandler = new SidePanelHandler('right');
    this._collaborationHandler = new PanelHandler();
    this._main = new Panel();
    const topWrapper = (this._topWrapper = new Panel());
    const menuWrapper = (this._menuWrapper = new Panel());
    const collaborationWrapper = (this._collaborationWrapper = new Panel());

    this._topHandler.panel.id = 'top-panel';
    this._topHandler.panel.node.setAttribute('role', 'banner');
    this._menuHandler.panel.id = 'menu-panel';
    this._menuHandler.panel.node.setAttribute('role', 'navigation');
    this._collaborationHandler.panel.id = 'collaboration-panel';
    this._collaborationHandler.panel.node.setAttribute('role', 'complementary');
    this._collaborationHandler.panel.node.setAttribute('aria-label', 'Collaboration tools');
    this._main.id = 'main-panel';
    this._main.node.setAttribute('role', 'main');

    this._spacer_top = new Widget();
    this._spacer_top.id = 'spacer-widget-top';
    this._spacer_bottom = new Widget();
    this._spacer_bottom.id = 'spacer-widget-bottom';

    // create wrappers around the top, menu, and collaboration areas
    topWrapper.id = 'top-panel-wrapper';
    topWrapper.addWidget(this._topHandler.panel);

    menuWrapper.id = 'menu-panel-wrapper';
    menuWrapper.addWidget(this._menuHandler.panel);

    collaborationWrapper.id = 'collaboration-panel-wrapper';
    collaborationWrapper.addWidget(this._collaborationHandler.panel);
    // Initially hide collaboration area - will be shown when collaboration is active
    collaborationWrapper.hide();

    const rootLayout = new BoxLayout();
    const leftHandler = this._leftHandler;
    const rightHandler = this._rightHandler;

    leftHandler.panel.id = 'jp-left-stack';
    leftHandler.panel.node.setAttribute('role', 'complementary');
    rightHandler.panel.id = 'jp-right-stack';
    rightHandler.panel.node.setAttribute('role', 'complementary');

    // Hide the side panels by default.
    leftHandler.hide();
    rightHandler.hide();

    const middleLayout = new BoxLayout({
      spacing: 0,
      direction: 'top-to-bottom',
    });
    BoxLayout.setStretch(this._topWrapper, 0);
    BoxLayout.setStretch(this._menuWrapper, 0);
    BoxLayout.setStretch(this._collaborationWrapper, 0);
    BoxLayout.setStretch(this._main, 1);

    const middlePanel = new Panel({ layout: middleLayout });
    middlePanel.addWidget(this._topWrapper);
    middlePanel.addWidget(this._menuWrapper);
    middlePanel.addWidget(this._collaborationWrapper);
    middlePanel.addWidget(this._spacer_top);
    middlePanel.addWidget(this._main);
    middlePanel.addWidget(this._spacer_bottom);
    middlePanel.layout = middleLayout;

    const vsplitPanel = new SplitPanel();
    vsplitPanel.id = 'jp-main-vsplit-panel';
    vsplitPanel.spacing = 1;
    vsplitPanel.orientation = 'vertical';
    SplitPanel.setStretch(vsplitPanel, 1);

    const downPanel = new TabPanelSvg({
      tabsMovable: true,
    });
    this._downPanel = downPanel;
    this._downPanel.id = 'jp-down-stack';

    // TODO: Consider storing this as an attribute this._hsplitPanel if saving/restoring layout needed
    const hsplitPanel = new SplitPanel();
    hsplitPanel.id = 'main-split-panel';
    hsplitPanel.spacing = 1;
    BoxLayout.setStretch(hsplitPanel, 1);

    SplitPanel.setStretch(leftHandler.panel, 0);
    SplitPanel.setStretch(rightHandler.panel, 0);
    SplitPanel.setStretch(middlePanel, 1);

    hsplitPanel.addWidget(leftHandler.panel);
    hsplitPanel.addWidget(middlePanel);
    hsplitPanel.addWidget(rightHandler.panel);

    // Use relative sizing to set the width of the side panels.
    // This will still respect the min-size of children widget in the stacked
    // panel.
    hsplitPanel.setRelativeSizes([1, 2.5, 1]);

    vsplitPanel.addWidget(hsplitPanel);
    vsplitPanel.addWidget(downPanel);

    rootLayout.spacing = 0;
    rootLayout.addWidget(vsplitPanel);

    // initially hiding the down panel
    this._downPanel.hide();

    // Connect down panel change listeners
    this._downPanel.tabBar.tabMoved.connect(this._onTabPanelChanged, this);
    this._downPanel.stackedPanel.widgetRemoved.connect(
      this._onTabPanelChanged,
      this
    );

    // Connect collaboration panel change listeners
    this._collaborationHandler.panel.childRemoved.connect(
      this._onCollaborationPanelChanged,
      this
    );

    this.layout = rootLayout;

    // Added Skip to Main Link
    const skipLinkWidgetHandler = (this._skipLinkWidgetHandler =
      new Private.SkipLinkWidgetHandler(this));

    this.add(skipLinkWidgetHandler.skipLinkWidget, 'top', { rank: 0 });
    this._skipLinkWidgetHandler.show();
  }

  /**
   * A signal emitted when the current widget changes.
   */
  get currentChanged(): ISignal<
    JupyterFrontEnd.IShell,
    FocusTracker.IChangedArgs<Widget>
  > {
    return this._currentChanged;
  }

  /**
   * The current widget in the shell's main area.
   */
  get currentWidget(): Widget | null {
    return this._main.widgets[0] ?? null;
  }

  /**
   * Get the top area wrapper panel
   */
  get top(): Widget {
    return this._topWrapper;
  }

  /**
   * Get the menu area wrapper panel
   */
  get menu(): Widget {
    return this._menuWrapper;
  }

  /**
   * Get the collaboration area wrapper panel
   */
  get collaboration(): Widget {
    return this._collaborationWrapper;
  }

  /**
   * Get the collaboration area handler
   */
  get collaborationHandler(): PanelHandler {
    return this._collaborationHandler;
  }

  /**
   * Get the left area handler
   */
  get leftHandler(): SidePanelHandler {
    return this._leftHandler;
  }

  /**
   * Get the right area handler
   */
  get rightHandler(): SidePanelHandler {
    return this._rightHandler;
  }

  /**
   * Is the left sidebar visible?
   */
  get leftCollapsed(): boolean {
    return !(this._leftHandler.isVisible && this._leftHandler.panel.isVisible);
  }

  /**
   * Is the right sidebar visible?
   */
  get rightCollapsed(): boolean {
    return !(
      this._rightHandler.isVisible && this._rightHandler.panel.isVisible
    );
  }

  /**
   * Promise that resolves when the main widget is loaded
   */
  get restored(): Promise<void> {
    return this._mainWidgetLoaded.promise;
  }

  /**
   * Getter and setter for the translator.
   */
  get translator(): ITranslator {
    return this._translator ?? nullTranslator;
  }
  set translator(value: ITranslator) {
    if (value !== this._translator) {
      this._translator = value;
      const trans = value.load('notebook');
      this._leftHandler.closeButton.title = trans.__(
        'Collapse %1 side panel',
        this._leftHandler.area
      );
      this._rightHandler.closeButton.title = trans.__(
        'Collapse %1 side panel',
        this._rightHandler.area
      );
    }
  }

  /**
   * User custom shell layout.
   */
  get userLayout() {
    return JSONExt.deepCopy(this._userLayout as any);
  }

  /**
   * Activate a widget in its area.
   */
  activateById(id: string): void {
    // Search all areas that can have widgets for this widget, starting with main.
    for (const area of ['main', 'top', 'left', 'right', 'menu', 'down', 'collaboration']) {
      const widget = find(
        this.widgets(area as INotebookShell.Area),
        (w) => w.id === id
      );
      if (widget) {
        if (area === 'left') {
          this.expandLeft(id);
        } else if (area === 'right') {
          this.expandRight(id);
        } else if (area === 'down') {
          this._downPanel.show();
          widget.activate();
        } else if (area === 'collaboration') {
          this.showCollaboration();
          widget.activate();
        } else {
          widget.activate();
        }
      }
    }
  }

  /**
   * Add a widget to the application shell.
   *
   * @param widget - The widget being added.
   *
   * @param area - Optional region in the shell into which the widget should
   * be added.
   *
   * @param options - Optional open options.
   *
   */
  add(
    widget: Widget,
    area?: INotebookShell.Area,
    options?: DocumentRegistry.IOpenOptions
  ): void {
    let userPosition: INotebookShell.IWidgetPosition | undefined;
    if (options?.type && this._userLayout[options.type]) {
      userPosition = this._userLayout[options.type];
    } else {
      userPosition = this._userLayout[widget.id];
    }

    area = userPosition?.area ?? area;
    options =
      options || userPosition?.options
        ? {
            ...options,
            ...userPosition?.options,
          }
        : undefined;

    const rank = options?.rank ?? DEFAULT_RANK;
    switch (area) {
      case 'top':
        return this._topHandler.addWidget(widget, rank);
      case 'menu':
        return this._menuHandler.addWidget(widget, rank);
      case 'collaboration': {
        // Check configuration to determine where to place collaboration widgets
        if (this._collaborationConfig.useTopArea) {
          // Place collaboration widgets in the top area instead
          this._topHandler.addWidget(widget, rank);
        } else {
          // Place in dedicated collaboration area
          this._collaborationHandler.addWidget(widget, rank);
          this.showCollaboration();
        }
        
        // Check if widget is a collaboration component and bind to services
        this._bindCollaborationWidget(widget, options);
        break;
      }
      case 'main':
      case undefined: {
        if (this._main.widgets.length > 0) {
          // do not add the widget if there is already one
          return;
        }
        const previousWidget = this.currentWidget;
        this._main.addWidget(widget);
        this._main.update();
        this._currentChanged.emit({
          newValue: widget,
          oldValue: previousWidget,
        });
        this._mainWidgetLoaded.resolve();
        break;
      }
      case 'left':
        return this._leftHandler.addWidget(widget, rank);
      case 'right':
        return this._rightHandler.addWidget(widget, rank);
      case 'down':
        return this._downPanel.addWidget(widget);
      default:
        console.warn(`Cannot add widget to area: ${area}`);
    }
  }

  /**
   * Collapse the top area and the spacer to make the view more compact.
   */
  collapseTop(): void {
    this._topWrapper.setHidden(true);
    this._spacer_top.setHidden(true);
  }

  /**
   * Expand the top area to show the header and the spacer.
   */
  expandTop(): void {
    this._topWrapper.setHidden(false);
    this._spacer_top.setHidden(false);
  }

  /**
   * Return the list of widgets for the given area.
   *
   * @param area The area
   */
  *widgets(area: INotebookShell.Area): IterableIterator<Widget> {
    switch (area ?? 'main') {
      case 'top':
        yield* this._topHandler.panel.widgets;
        return;
      case 'menu':
        yield* this._menuHandler.panel.widgets;
        return;
      case 'collaboration':
        if (this._collaborationConfig.useTopArea) {
          // Filter top area widgets to only return collaboration widgets
          for (const widget of this._topHandler.panel.widgets) {
            if (this._isCollaborationWidget(widget)) {
              yield widget;
            }
          }
        } else {
          yield* this._collaborationHandler.panel.widgets;
        }
        return;
      case 'main':
        yield* this._main.widgets;
        return;
      case 'left':
        yield* this._leftHandler.widgets;
        return;
      case 'right':
        yield* this._rightHandler.widgets;
        return;
      case 'down':
        yield* this._downPanel.widgets;
        return;
      default:
        console.error(`This shell has no area called "${area}"`);
        return;
    }
  }

  /**
   * Expand the left panel to show the sidebar with its widget.
   */
  expandLeft(id?: string): void {
    this._leftHandler.panel.show();
    this._leftHandler.expand(id); // Show the current widget, if any
  }

  /**
   * Collapse the left panel
   */
  collapseLeft(): void {
    this._leftHandler.collapse();
    this._leftHandler.panel.hide();
  }

  /**
   * Expand the right panel to show the sidebar with its widget.
   */
  expandRight(id?: string): void {
    this._rightHandler.panel.show();
    this._rightHandler.expand(id); // Show the current widget, if any
  }

  /**
   * Collapse the right panel
   */
  collapseRight(): void {
    this._rightHandler.collapse();
    this._rightHandler.panel.hide();
  }

  /**
   * Show the collaboration area if it contains widgets.
   */
  showCollaboration(): void {
    if (this._collaborationHandler.panel.widgets.length > 0) {
      this._collaborationWrapper.show();
    }
  }

  /**
   * Hide the collaboration area.
   */
  hideCollaboration(): void {
    this._collaborationWrapper.hide();
  }

  /**
   * Check if collaboration area is visible.
   */
  get isCollaborationVisible(): boolean {
    return this._collaborationWrapper.isVisible;
  }

  /**
   * Get the collaboration area configuration.
   */
  get collaborationConfig(): { useTopArea: boolean; enabled: boolean } {
    return this._collaborationConfig;
  }

  /**
   * Set collaboration area configuration.
   */
  setCollaborationConfig(config: { useTopArea?: boolean; enabled?: boolean }): void {
    this._collaborationConfig = { ...this._collaborationConfig, ...config };
    
    if (!config.enabled) {
      this.hideCollaboration();
    }
  }

  /**
   * Restore the layout state and configuration for the application shell.
   */
  async restoreLayout(
    configuration: INotebookShell.IUserLayout
  ): Promise<void> {
    this._userLayout = configuration;
  }

  /**
   * Handle a change on the down panel widgets
   */
  private _onTabPanelChanged(): void {
    if (this._downPanel.stackedPanel.widgets.length === 0) {
      this._downPanel.hide();
    }
  }

  /**
   * Handle a change on the collaboration panel widgets
   */
  private _onCollaborationPanelChanged(): void {
    if (this._collaborationHandler.panel.widgets.length === 0) {
      this.hideCollaboration();
    }
  }

  /**
   * Bind collaboration-specific services to widgets that need them.
   */
  private _bindCollaborationWidget(
    widget: Widget,
    options?: DocumentRegistry.IOpenOptions
  ): void {
    // Check if widget needs collaboration service binding
    const widgetId = widget.id;
    const widgetType = options?.type;

    try {
      // Handle different types of collaboration widgets
      if (widgetId.includes('collaboration-bar') || widgetType === 'collaboration-bar') {
        this._bindCollaborationBarWidget(widget);
      } else if (widgetId.includes('user-presence') || widgetType === 'user-presence') {
        this._bindUserPresenceWidget(widget);
      } else if (widgetId.includes('cell-lock') || widgetType === 'cell-lock') {
        this._bindCellLockWidget(widget);
      } else if (widgetId.includes('comment-system') || widgetType === 'comment-system') {
        this._bindCommentSystemWidget(widget);
      }

      // Set up proper disposal for collaboration widgets
      this._setupCollaborationWidgetDisposal(widget);
    } catch (error) {
      console.warn('Failed to bind collaboration services to widget:', error);
    }
  }

  /**
   * Bind collaboration services to a collaboration bar widget.
   */
  private _bindCollaborationBarWidget(widget: Widget): void {
    // Implementation will depend on actual widget interface
    // This is a placeholder for proper service injection
    if ((widget as any).setCollaborationServices) {
      (widget as any).setCollaborationServices({
        collaborationProvider: this._collaborationProvider,
        awarenessService: this._awarenessService,
        lockService: this._lockService,
        commentService: this._commentService,
        historyManager: this._historyManager,
        permissionsManager: this._permissionsManager
      });
    }
  }

  /**
   * Bind awareness service to a user presence widget.
   */
  private _bindUserPresenceWidget(widget: Widget): void {
    if ((widget as any).setAwarenessService && this._awarenessService) {
      (widget as any).setAwarenessService(this._awarenessService);
    }
  }

  /**
   * Bind lock service to a cell lock indicator widget.
   */
  private _bindCellLockWidget(widget: Widget): void {
    if ((widget as any).setLockService && this._lockService) {
      (widget as any).setLockService(this._lockService);
    }
  }

  /**
   * Bind comment service to a comment system widget.
   */
  private _bindCommentSystemWidget(widget: Widget): void {
    if ((widget as any).setCommentService && this._commentService) {
      (widget as any).setCommentService(this._commentService);
    }
  }

  /**
   * Set up proper disposal handling for collaboration widgets.
   */
  private _setupCollaborationWidgetDisposal(widget: Widget): void {
    widget.disposed.connect(() => {
      // Clean up any collaboration-specific resources
      if ((widget as any).disposeCollaborationBindings) {
        (widget as any).disposeCollaborationBindings();
      }
    });
  }

  /**
   * Set collaboration service instances for widget binding.
   */
  setCollaborationServices(services: {
    collaborationProvider?: ICollaborationProvider;
    awarenessService?: AwarenessService;
    lockService?: LockService;
    commentService?: CommentService;
    historyManager?: HistoryManager;
    permissionsManager?: PermissionsManager;
  }): void {
    this._collaborationProvider = services.collaborationProvider;
    this._awarenessService = services.awarenessService;
    this._lockService = services.lockService;
    this._commentService = services.commentService;
    this._historyManager = services.historyManager;
    this._permissionsManager = services.permissionsManager;
  }

  /**
   * Check if a widget is a collaboration widget.
   */
  private _isCollaborationWidget(widget: Widget): boolean {
    const widgetId = widget.id;
    const collaborationWidgetIds = [
      'collaboration-bar',
      'user-presence',
      'cell-lock-indicator',
      'comment-system',
      'history-viewer',
      'permissions-dialog'
    ];
    
    return collaborationWidgetIds.some(id => widgetId.includes(id)) ||
           widget.hasClass('jp-CollaborationWidget');
  }

  private _topWrapper: Panel;
  private _topHandler: PanelHandler;
  private _menuWrapper: Panel;
  private _menuHandler: PanelHandler;
  private _collaborationWrapper: Panel;
  private _collaborationHandler: PanelHandler;
  private _leftHandler: SidePanelHandler;
  private _rightHandler: SidePanelHandler;
  private _spacer_top: Widget;
  private _spacer_bottom: Widget;
  private _skipLinkWidgetHandler: Private.SkipLinkWidgetHandler;
  private _main: Panel;
  private _downPanel: TabPanel;
  private _translator: ITranslator = nullTranslator;
  private _currentChanged = new Signal<this, FocusTracker.IChangedArgs<Widget>>(
    this
  );
  private _mainWidgetLoaded = new PromiseDelegate<void>();
  private _userLayout: INotebookShell.IUserLayout;
  
  // Collaboration-related private fields
  private _collaborationConfig: { useTopArea: boolean; enabled: boolean } = {
    useTopArea: false,
    enabled: true
  };
  private _collaborationProvider?: ICollaborationProvider;
  private _awarenessService?: AwarenessService;
  private _lockService?: LockService;
  private _commentService?: CommentService;
  private _historyManager?: HistoryManager;
  private _permissionsManager?: PermissionsManager;
}

export namespace Private {
  export class SkipLinkWidgetHandler {
    /**
     * Construct a new skipLink widget handler.
     */
    constructor(shell: INotebookShell) {
      const skipLinkWidget = (this._skipLinkWidget = new Widget());
      const skipToMain = document.createElement('a');
      skipToMain.href = '#first-cell';
      skipToMain.tabIndex = 1;
      skipToMain.text = 'Skip to Main';
      skipToMain.className = 'skip-link';
      skipToMain.addEventListener('click', this);
      skipLinkWidget.addClass('jp-skiplink');
      skipLinkWidget.id = 'jp-skiplink';
      skipLinkWidget.node.appendChild(skipToMain);
    }

    handleEvent(event: Event): void {
      switch (event.type) {
        case 'click':
          this._focusMain();
          break;
      }
    }

    private _focusMain() {
      const input = document.querySelector(
        '#main-panel .jp-InputArea-editor'
      ) as HTMLInputElement;
      input.tabIndex = 1;
      input.focus();
    }

    /**
     * Get the input element managed by the handler.
     */
    get skipLinkWidget(): Widget {
      return this._skipLinkWidget;
    }

    /**
     * Dispose of the handler and the resources it holds.
     */
    dispose(): void {
      if (this.isDisposed) {
        return;
      }
      this._isDisposed = true;
      this._skipLinkWidget.node.removeEventListener('click', this);
      this._skipLinkWidget.dispose();
    }

    /**
     * Hide the skipLink widget.
     */
    hide(): void {
      this._skipLinkWidget.hide();
    }

    /**
     * Show the skipLink widget.
     */
    show(): void {
      this._skipLinkWidget.show();
    }

    /**
     * Test whether the handler has been disposed.
     */
    get isDisposed(): boolean {
      return this._isDisposed;
    }

    private _skipLinkWidget: Widget;
    private _isDisposed = false;
  }
}
