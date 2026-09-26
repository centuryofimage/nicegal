# Renderer ownership

`GalleryView.svelte` composes the workspace, viewer, status bar, toolbar, and dialogs.
It owns component references and local presentation state (Info visibility and Settings page).

## Where to put a change

| Change                                                                        | Owner                              |
| ----------------------------------------------------------------------------- | ---------------------------------- |
| Workspace-wide keyboard shortcut, such as Ctrl/Cmd+L                          | `lib/gallery-shortcuts.ts`         |
| Search-field/composer keys and editing                                        | `components/SearchBar.svelte`      |
| Viewer keys, zoom, and fullscreen                                             | `components/DetailView.svelte`     |
| Search toolbar wiring and selected-image actions                              | `components/GalleryToolbar.svelte` |
| Visual-search file picker and dropped-file import                             | `lib/visual-search-input.ts`       |
| Ctrl+wheel tile sizing                                                        | `lib/gallery/wheel-zoom.ts`        |
| Libraries/Settings/Getting Started dialog composition                         | `components/GalleryDialogs.svelte` |
| Getting Started content and styling                                           | `components/GettingStarted.svelte` |
| Selection, viewer navigation, library restoration, and search-view derivation | `lib/library-view.svelte.ts`       |
| Query execution, results, and visual-search session state                     | `lib/ocr-search.svelte.ts`         |
| App lifecycle, backend/native services, and cross-service commands            | `lib/application.svelte.ts`        |

## Shortcuts and focus

Global shortcuts are registered once by `GalleryView`. The handler receives named actions,
so keyboard policy stays separate from state changes. Components may handle their local keys
first with `preventDefault()` or `stopPropagation()`; the global handler respects that.

For example, Ctrl/Cmd+L calls `GalleryToolbar.focusSearch()`, which calls `SearchBar.focus()`.
DOM references stay in the component that owns the element. `application.svelte.ts` should
not store elements or interpret keyboard events.

`Application` is not just a backend wrapper: it coordinates catalog/search/job/runtime services,
native file actions, startup, recovery, and persisted onboarding dismissal. Those lifetimes
outlast individual controls. Local focus, open popovers, and keyboard routing belong to the UI.

## State and component boundaries

Keep shared service state in the application context; pass the existing library-view controller
to workspace components. Do not copy its reactive state into separate component stores.
Keep imperative component methods small (focus, scroll, retry thumbnails), and keep their
references in the composing view. Styles move with their markup and continue to use theme tokens.

Visual-file imports check the search-session revision before publishing asynchronous results,
so clearing a search or changing scope cannot be undone by a late file-picker response.
