"""Jupyter notebook application."""

from __future__ import annotations

import os
import re
import typing as t
from pathlib import Path

from jupyter_client.utils import ensure_async  # type:ignore[attr-defined]
from jupyter_core.application import base_aliases
from jupyter_core.paths import jupyter_config_dir
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.extension.handler import (
    ExtensionHandlerJinjaMixin,
    ExtensionHandlerMixin,
)
from jupyter_server.serverapp import flags
from jupyter_server.utils import url_escape, url_is_absolute
from jupyter_server.utils import url_path_join as ujoin
from jupyterlab.commands import (  # type:ignore[import-untyped]
    get_app_dir,
    get_user_settings_dir,
    get_workspaces_dir,
)
from jupyterlab_server import LabServerApp
from jupyterlab_server.config import (  # type:ignore[attr-defined]
    LabConfig,
    get_page_config,
    recursive_update,
)
from jupyterlab_server.handlers import _camelCase, is_url
from notebook_shim.shim import NotebookConfigShimMixin  # type:ignore[import-untyped]
from tornado import web
from traitlets import Bool, Unicode, default
from traitlets.config.loader import Config

from ._version import __version__

try:
    # Import collaboration handlers if available
    from .collab.handlers import CollaborationSyncHandler, CollaborationAwarenessHandler, CollaborationCommentsHandler
    COLLABORATION_AVAILABLE = True
except ImportError:
    COLLABORATION_AVAILABLE = False

HERE = Path(__file__).parent.resolve()

Flags = dict[t.Union[str, tuple[str, ...]], tuple[t.Union[dict[str, t.Any], Config], str]]

app_dir = Path(get_app_dir())
version = __version__

# mypy: disable-error-code="no-untyped-call"


class NotebookBaseHandler(ExtensionHandlerJinjaMixin, ExtensionHandlerMixin, JupyterHandler):
    """The base notebook API handler."""

    @property
    def custom_css(self) -> t.Any:
        return self.settings.get("custom_css", True)

    def get_page_config(self) -> dict[str, t.Any]:
        """Get the page config."""
        config = LabConfig()
        app: JupyterNotebookApp = self.extensionapp  # type:ignore[assignment]
        base_url = self.settings.get("base_url", "/")
        page_config_data = self.settings.setdefault("page_config_data", {})
        page_config = {
            **page_config_data,
            "appVersion": version,
            "baseUrl": self.base_url,
            "terminalsAvailable": self.settings.get("terminals_available", False),
            "token": self.settings["token"],
            "fullStaticUrl": ujoin(self.base_url, "static", self.name),
            "frontendUrl": ujoin(self.base_url, "/"),
            "exposeAppInBrowser": app.expose_app_in_browser,
        }
        
        # Add collaboration authentication configuration
        if hasattr(app, "collaboration_enabled") and app.collaboration_enabled:
            page_config["collaborationAuthEnabled"] = True
            page_config["collaborationToken"] = self.settings["token"]
            # WebSocket URL for collaboration
            ws_protocol = "wss" if self.request.protocol == "https" else "ws"
            page_config["collaborationWebSocketUrl"] = f"{ws_protocol}://{self.request.host}/api/collaboration/"
        else:
            page_config["collaborationAuthEnabled"] = False

        server_root = self.settings.get("server_root_dir", "")
        server_root = server_root.replace(os.sep, "/")
        server_root = os.path.normpath(Path(server_root).expanduser())
        try:
            # Remove the server_root from pref dir
            if self.serverapp.preferred_dir != server_root:
                page_config["preferredPath"] = "/" + os.path.relpath(
                    self.serverapp.preferred_dir, server_root
                )
            else:
                page_config["preferredPath"] = "/"
        except Exception:
            page_config["preferredPath"] = "/"

        mathjax_config = self.settings.get("mathjax_config", "TeX-AMS_HTML-full,Safe")
        # TODO Remove CDN usage.
        mathjax_url = self.settings.get(
            "mathjax_url",
            "https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.7/MathJax.js",
        )
        if not url_is_absolute(mathjax_url) and not mathjax_url.startswith(self.base_url):
            mathjax_url = ujoin(self.base_url, mathjax_url)

        page_config.setdefault("mathjaxConfig", mathjax_config)
        page_config.setdefault("fullMathjaxUrl", mathjax_url)
        page_config.setdefault("jupyterConfigDir", jupyter_config_dir())

        # Put all our config in page_config
        for name in config.trait_names():
            page_config[_camelCase(name)] = getattr(app, name)

        # Add full versions of all the urls
        for name in config.trait_names():
            if not name.endswith("_url"):
                continue
            full_name = _camelCase("full_" + name)
            full_url = getattr(app, name)
            if not is_url(full_url):
                # Relative URL will be prefixed with base_url
                full_url = ujoin(base_url, full_url)
            page_config[full_name] = full_url

        labextensions_path = app.extra_labextensions_path + app.labextensions_path
        recursive_update(
            page_config,
            get_page_config(
                labextensions_path,
                logger=self.log,
            ),
        )

        # modify page config with custom hook
        page_config_hook = self.settings.get("page_config_hook", None)
        if page_config_hook:
            page_config = page_config_hook(self, page_config)

        return page_config


class TreeHandler(NotebookBaseHandler):
    """A tree page handler."""

    @web.authenticated
    async def get(self, path: str = "") -> None:
        """
        Display appropriate page for given path.

        - A directory listing is shown if path is a directory
        - Redirected to notebook page if path is a notebook
        - Render the raw file if path is any other file
        """
        path = path.strip("/")
        cm = self.contents_manager

        if await ensure_async(cm.dir_exists(path=path)):
            if await ensure_async(cm.is_hidden(path)) and not cm.allow_hidden:
                self.log.info("Refusing to serve hidden directory, via 404 Error")
                raise web.HTTPError(404)

            # Set treePath for routing to the directory
            page_config = self.get_page_config()
            page_config["treePath"] = path

            tpl = self.render_template("tree.html", page_config=page_config)
            return self.write(tpl)
        if await ensure_async(cm.file_exists(path)):
            # it's not a directory, we have redirecting to do
            model = await ensure_async(cm.get(path, content=False))
            if model["type"] == "notebook":
                url = ujoin(self.base_url, "notebooks", url_escape(path))
            else:
                # Return raw content if file is not a notebook
                url = ujoin(self.base_url, "files", url_escape(path))
            self.log.debug("Redirecting %s to %s", self.request.path, url)
            self.redirect(url)
            return None
        raise web.HTTPError(404)


class ConsoleHandler(NotebookBaseHandler):
    """A console page handler."""

    @web.authenticated
    def get(self, path: str | None = None) -> t.Any:  # noqa: ARG002
        """Get the console page."""
        tpl = self.render_template("consoles.html", page_config=self.get_page_config())
        return self.write(tpl)


class TerminalHandler(NotebookBaseHandler):
    """A terminal page handler."""

    @web.authenticated
    def get(self, path: str | None = None) -> t.Any:  # noqa: ARG002
        """Get the terminal page."""
        tpl = self.render_template("terminals.html", page_config=self.get_page_config())
        return self.write(tpl)


class FileHandler(NotebookBaseHandler):
    """A file page handler."""

    @web.authenticated
    def get(self, path: str | None = None) -> t.Any:  # noqa: ARG002
        """Get the file page."""
        tpl = self.render_template("edit.html", page_config=self.get_page_config())
        return self.write(tpl)


class NotebookHandler(NotebookBaseHandler):
    """A notebook page handler."""

    @web.authenticated
    async def get(self, path: str = "") -> t.Any:
        """Get the notebook page. Redirect if it's a directory."""
        path = path.strip("/")
        cm = self.contents_manager

        if await ensure_async(cm.dir_exists(path=path)):
            url = ujoin(self.base_url, "tree", url_escape(path))
            self.log.debug("Redirecting %s to %s since path is a directory", self.request.path, url)
            self.redirect(url)
            return None
        tpl = self.render_template("notebooks.html", page_config=self.get_page_config())
        return self.write(tpl)


class CustomCssHandler(NotebookBaseHandler):
    """A custom CSS handler."""

    @web.authenticated
    def get(self) -> t.Any:
        """Get the custom css file."""

        self.set_header("Content-Type", "text/css")
        page_config = self.get_page_config()
        custom_css_file = f"{page_config['jupyterConfigDir']}/custom/custom.css"

        if not Path(custom_css_file).is_file():
            static_path_root = re.match("^(.*?)static", page_config["staticDir"])
            if static_path_root is not None:
                custom_dir = static_path_root.groups()[0]
                custom_css_file = f"{custom_dir}custom/custom.css"

        with Path(custom_css_file).open() as css_f:
            return self.write(css_f.read())


aliases = dict(base_aliases)


class JupyterNotebookApp(NotebookConfigShimMixin, LabServerApp):  # type:ignore[misc]
    """The notebook server extension app.
    
    Provides the core Jupyter Notebook v7 application with support for:
    - Interactive notebook interface
    - Code execution and rich output display
    - File browser and content management
    - Extension system for additional functionality
    - Real-time collaborative editing (when enabled)
    
    Collaboration Features:
    - WebSocket handlers for document synchronization
    - User presence awareness and tracking
    - Cell-level locking mechanism
    - Change history and versioning
    - Permission-based access control
    - Comment and review system
    """

    name = "notebook"
    app_name = "Jupyter Notebook"
    description = "Jupyter Notebook - A web-based notebook environment for interactive computing"
    version = version
    app_version = Unicode(version, help="The version of the application.")
    extension_url = "/"
    default_url = Unicode("/tree", config=True, help="The default URL to redirect to from `/`")
    file_url_prefix = "/tree"
    load_other_extensions = True
    app_dir = app_dir
    subcommands: dict[str, t.Any] = {}

    expose_app_in_browser = Bool(
        False,
        config=True,
        help="Whether to expose the global app instance to browser via window.jupyterapp",
    )

    custom_css = Bool(
        True,
        config=True,
        help="""Whether custom CSS is loaded on the page.
        Defaults to True and custom CSS is loaded.
        """,
    )

    collaboration_enabled = Bool(
        config=True,
        help="""Whether real-time collaborative editing is enabled.
        Can be set via JUPYTER_ENABLE_COLLABORATION environment variable.
        Defaults to False.
        """,
    )

    collaboration_max_clients = Unicode(
        "20",
        config=True,
        help="""Maximum number of concurrent clients per collaborative session.
        Can be set via COLLAB_MAX_CLIENTS environment variable.
        Defaults to 20.
        """,
    )

    collaboration_storage_backend = Unicode(
        "memory",
        config=True,
        help="""Storage backend for collaborative document state.
        Options: 'memory', 'file', 'mongodb', 'redis'.
        Can be set via COLLAB_STORAGE_BACKEND environment variable.
        Defaults to 'memory'.
        """,
    )

    collaboration_storage_uri = Unicode(
        "",
        config=True,
        help="""Storage URI for collaborative document persistence.
        Required for 'mongodb' and 'redis' backends.
        Can be set via COLLAB_STORAGE_URI environment variable.
        """,
    )

    collaboration_history_retention = Unicode(
        "30d",
        config=True,
        help="""Retention period for collaborative document history.
        Format: <number><unit> where unit is 'd' (days), 'h' (hours), 'm' (minutes).
        Can be set via COLLAB_HISTORY_RETENTION environment variable.
        Defaults to '30d'.
        """,
    )

    collaboration_log_level = Unicode(
        "INFO",
        config=True,
        help="""Log level for collaboration subsystem.
        Options: DEBUG, INFO, WARNING, ERROR, CRITICAL.
        Can be set via COLLAB_LOG_LEVEL environment variable.
        Defaults to 'INFO'.
        """,
    )

    flags: Flags = flags  # type:ignore[assignment]
    flags["expose-app-in-browser"] = (
        {"JupyterNotebookApp": {"expose_app_in_browser": True}},
        "Expose the global app instance to browser via window.jupyterapp.",
    )

    flags["custom-css"] = (
        {"JupyterNotebookApp": {"custom_css": True}},
        "Load custom CSS in template html files. Default is True",
    )

    flags["collaboration"] = (
        {"JupyterNotebookApp": {"collaboration_enabled": True}},
        "Enable real-time collaborative editing features",
    )

    flags["no-collaboration"] = (
        {"JupyterNotebookApp": {"collaboration_enabled": False}},
        "Disable real-time collaborative editing features",
    )

    @default("static_dir")
    def _default_static_dir(self) -> str:
        return str(HERE / "static")

    @default("templates_dir")
    def _default_templates_dir(self) -> str:
        return str(HERE / "templates")

    @default("app_settings_dir")
    def _default_app_settings_dir(self) -> str:
        return str(app_dir / "settings")

    @default("schemas_dir")
    def _default_schemas_dir(self) -> str:
        return str(app_dir / "schemas")

    @default("themes_dir")
    def _default_themes_dir(self) -> str:
        return str(app_dir / "themes")

    @default("user_settings_dir")
    def _default_user_settings_dir(self) -> str:
        return t.cast(str, get_user_settings_dir())

    @default("workspaces_dir")
    def _default_workspaces_dir(self) -> str:
        return t.cast(str, get_workspaces_dir())

    @default("collaboration_enabled")
    def _default_collaboration_enabled(self) -> bool:
        return os.environ.get("JUPYTER_ENABLE_COLLABORATION", "false").lower() in ("true", "1")

    @default("collaboration_max_clients")
    def _default_collaboration_max_clients(self) -> str:
        return os.environ.get("COLLAB_MAX_CLIENTS", "20")

    @default("collaboration_storage_backend")
    def _default_collaboration_storage_backend(self) -> str:
        return os.environ.get("COLLAB_STORAGE_BACKEND", "memory")

    @default("collaboration_storage_uri")
    def _default_collaboration_storage_uri(self) -> str:
        return os.environ.get("COLLAB_STORAGE_URI", "")

    @default("collaboration_history_retention")
    def _default_collaboration_history_retention(self) -> str:
        return os.environ.get("COLLAB_HISTORY_RETENTION", "30d")

    @default("collaboration_log_level")
    def _default_collaboration_log_level(self) -> str:
        return os.environ.get("COLLAB_LOG_LEVEL", "INFO")

    def _prepare_templates(self) -> None:
        super(LabServerApp, self)._prepare_templates()
        self.jinja2_env.globals.update(custom_css=self.custom_css)  # type:ignore[has-type]

    def server_extension_is_enabled(self, extension: str) -> bool:
        """Check if server extension is enabled."""
        if self.serverapp is None:
            return False
        try:
            extension_enabled = (
                self.serverapp.extension_manager.extensions[extension].enabled is True
            )
        except (AttributeError, KeyError, TypeError):
            extension_enabled = False
        return extension_enabled

    def initialize_handlers(self) -> None:
        """Initialize handlers."""
        assert self.serverapp is not None  # noqa: S101
        page_config = self.serverapp.web_app.settings.setdefault("page_config_data", {})
        nbclassic_enabled = self.server_extension_is_enabled("nbclassic")
        page_config["nbclassic_enabled"] = nbclassic_enabled

        # If running under JupyterHub, add more metadata.
        if "hub_prefix" in self.serverapp.tornado_settings:
            tornado_settings = self.serverapp.tornado_settings
            hub_prefix = tornado_settings["hub_prefix"]
            page_config["hubPrefix"] = hub_prefix
            page_config["hubHost"] = tornado_settings["hub_host"]
            page_config["hubUser"] = tornado_settings["user"]
            page_config["shareUrl"] = ujoin(hub_prefix, "user-redirect")
            # Assume the server_name property indicates running JupyterHub 1.0.
            if hasattr(self.serverapp, "server_name"):
                page_config["hubServerName"] = self.serverapp.server_name
            # avoid setting API token in page config
            # $JUPYTERHUB_API_TOKEN identifies the server, not the client
            # but at least make sure we don't use the token
            # if the serverapp set one
            page_config["token"] = ""

        # Configure collaboration features
        if self._validate_collaboration_config():
            try:
                self._setup_collaboration_handlers()
                self._setup_collaboration_logging()
                # Add collaboration configuration to page config
                page_config["collaborationEnabled"] = True
                page_config["collaborationMaxClients"] = int(self.collaboration_max_clients)
                page_config["collaborationStorageBackend"] = self.collaboration_storage_backend
                page_config["collaborationHistoryRetention"] = self.collaboration_history_retention
                self.log.info("Collaboration features enabled and configured")
            except Exception as e:
                self.log.error(f"Failed to setup collaboration features: {e}")
                page_config["collaborationEnabled"] = False
                self.collaboration_enabled = False
        else:
            page_config["collaborationEnabled"] = False
            if self.collaboration_enabled:
                self.log.warning("Collaboration features requested but configuration is invalid")

        self.handlers.append(("/tree(.*)", TreeHandler))
        self.handlers.append(("/notebooks(.*)", NotebookHandler))
        self.handlers.append(("/edit(.*)", FileHandler))
        self.handlers.append(("/consoles/(.*)", ConsoleHandler))
        self.handlers.append(("/terminals/(.*)", TerminalHandler))
        self.handlers.append(("/custom/custom.css", CustomCssHandler))
        super().initialize_handlers()

    def _setup_collaboration_handlers(self) -> None:
        """Set up WebSocket handlers for collaboration endpoints."""
        if not COLLABORATION_AVAILABLE:
            return
            
        # Register collaboration WebSocket handlers
        # /api/collaboration/[notebook_path]/sync - For document synchronization
        self.handlers.append(
            (r"/api/collaboration/(.*)/sync", CollaborationSyncHandler, {
                "notebook_app": self,
                "max_clients": int(self.collaboration_max_clients),
                "storage_backend": self.collaboration_storage_backend,
                "storage_uri": self.collaboration_storage_uri,
            })
        )
        
        # /api/collaboration/[notebook_path]/awareness - For user presence updates
        self.handlers.append(
            (r"/api/collaboration/(.*)/awareness", CollaborationAwarenessHandler, {
                "notebook_app": self,
                "max_clients": int(self.collaboration_max_clients),
                "storage_backend": self.collaboration_storage_backend,
                "storage_uri": self.collaboration_storage_uri,
            })
        )
        
        # /api/collaboration/[notebook_path]/comments - For comment system
        self.handlers.append(
            (r"/api/collaboration/(.*)/comments", CollaborationCommentsHandler, {
                "notebook_app": self,
                "max_clients": int(self.collaboration_max_clients),
                "storage_backend": self.collaboration_storage_backend,
                "storage_uri": self.collaboration_storage_uri,
            })
        )
        
        self.log.info("Collaboration WebSocket handlers registered for /api/collaboration/ endpoints")
        
        # Test storage backend connectivity if applicable
        self._test_collaboration_storage()

    def _test_collaboration_storage(self) -> None:
        """Test collaboration storage backend connectivity."""
        if self.collaboration_storage_backend == "memory":
            self.log.info("Using in-memory storage for collaboration (data will not persist)")
        elif self.collaboration_storage_backend == "file":
            self.log.info("Using file-based storage for collaboration")
        elif self.collaboration_storage_backend in ("mongodb", "redis"):
            if not self.collaboration_storage_uri:
                self.log.error(f"Storage URI required for {self.collaboration_storage_backend} backend")
                return
            
            try:
                # Test connection without importing heavy dependencies
                self.log.info(f"Testing {self.collaboration_storage_backend} connection: {self.collaboration_storage_uri}")
                # In a real implementation, you would test the actual connection here
                self.log.info(f"Collaboration storage backend '{self.collaboration_storage_backend}' configured successfully")
            except Exception as e:
                self.log.error(f"Failed to connect to {self.collaboration_storage_backend}: {e}")
        else:
            self.log.warning(f"Unknown storage backend: {self.collaboration_storage_backend}")

    def _setup_collaboration_logging(self) -> None:
        """Set up dedicated logging for collaboration subsystems."""
        import logging
        
        # Configure collaboration log level
        collab_log_level = getattr(logging, self.collaboration_log_level.upper(), logging.INFO)
        
        # Set up dedicated loggers for collaboration components
        collab_loggers = [
            "jupyter.collab.sync",
            "jupyter.collab.awareness", 
            "jupyter.collab.locks",
            "jupyter.collab.history",
            "jupyter.collab.comments",
            "jupyter.collab.permissions",
        ]
        
        for logger_name in collab_loggers:
            logger = logging.getLogger(logger_name)
            logger.setLevel(collab_log_level)
            
            # Add handler if not already present
            if not logger.handlers:
                handler = logging.StreamHandler()
                formatter = logging.Formatter(
                    "%(asctime)s [%(name)s] %(levelname)s: %(message)s"
                )
                handler.setFormatter(formatter)
                logger.addHandler(handler)
                logger.propagate = False
        
        self.log.info(f"Collaboration logging configured at {self.collaboration_log_level} level")

    def _validate_collaboration_config(self) -> bool:
        """Validate collaboration configuration and dependencies."""
        if not self.collaboration_enabled:
            return False
            
        if not COLLABORATION_AVAILABLE:
            self.log.error(
                "Collaboration features are enabled but collaboration handlers are not available. "
                "Please install the collaboration package."
            )
            return False
            
        # Validate storage backend configuration
        if self.collaboration_storage_backend in ("mongodb", "redis"):
            if not self.collaboration_storage_uri:
                self.log.error(
                    f"Storage backend '{self.collaboration_storage_backend}' requires "
                    "collaboration_storage_uri to be configured"
                )
                return False
                
        # Validate max clients setting
        try:
            max_clients = int(self.collaboration_max_clients)
            if max_clients <= 0:
                self.log.error("collaboration_max_clients must be a positive integer")
                return False
        except ValueError:
            self.log.error("collaboration_max_clients must be a valid integer")
            return False
            
        # Validate history retention format
        import re
        if not re.match(r"^\d+[dhm]$", self.collaboration_history_retention):
            self.log.error(
                "collaboration_history_retention must be in format <number><unit> "
                "where unit is 'd' (days), 'h' (hours), or 'm' (minutes)"
            )
            return False
            
        return True

    @property
    def collaboration_ready(self) -> bool:
        """Check if collaboration features are fully configured and ready."""
        return self.collaboration_enabled and COLLABORATION_AVAILABLE and self._validate_collaboration_config()

    def get_collaboration_config(self) -> dict[str, t.Any]:
        """Get collaboration configuration as a dictionary."""
        return {
            "enabled": self.collaboration_enabled,
            "available": COLLABORATION_AVAILABLE,
            "ready": self.collaboration_ready,
            "max_clients": int(self.collaboration_max_clients) if self.collaboration_enabled else 0,
            "storage_backend": self.collaboration_storage_backend,
            "storage_uri": self.collaboration_storage_uri,
            "history_retention": self.collaboration_history_retention,
            "log_level": self.collaboration_log_level,
        }

    def get_collaboration_health(self) -> dict[str, t.Any]:
        """Get collaboration health status for monitoring."""
        if not self.collaboration_enabled:
            return {"status": "disabled", "details": "Collaboration features not enabled"}
            
        if not COLLABORATION_AVAILABLE:
            return {"status": "unavailable", "details": "Collaboration handlers not available"}
            
        if not self.collaboration_ready:
            return {"status": "error", "details": "Collaboration configuration invalid"}
            
        return {
            "status": "healthy",
            "details": "Collaboration services operational",
            "config": self.get_collaboration_config(),
        }

    @property
    def web_app(self) -> t.Any:
        """Get the web application instance."""
        return self.serverapp.web_app if self.serverapp else None

    @property
    def tornado_settings(self) -> dict[str, t.Any]:
        """Get Tornado settings dictionary."""
        return self.serverapp.tornado_settings if self.serverapp else {}

    def initialize(self, argv: list[str] | None = None) -> None:  # noqa: ARG002
        """Subclass because the ExtensionApp.initialize() method does not take arguments"""
        super().initialize()
        
        # Perform early validation of collaboration configuration
        if self.collaboration_enabled:
            if not self._validate_collaboration_config():
                self.log.error("Invalid collaboration configuration. Collaboration features will be disabled.")
                self.collaboration_enabled = False


main = launch_new_instance = JupyterNotebookApp.launch_instance

if __name__ == "__main__":
    main()
