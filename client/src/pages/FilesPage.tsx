import {
	ArrowLeft,
	ChevronRight,
	File,
	Folder,
	FolderOpen,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../apiUrl.ts";
import { useApi } from "../hooks/useApi.ts";
import "./FilesPage.css";

interface DirEntry {
	name: string;
	type: "file" | "directory";
	size: number;
}

interface DirListing {
	entries: DirEntry[];
	truncated: boolean;
}

interface TreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	size: number;
	children?: TreeNode[];
	expanded: boolean;
	loading: boolean;
}

type LanguageLoader = () => Promise<
	import("@codemirror/language").LanguageSupport
>;

function getLanguageLoader(filename: string): LanguageLoader | null {
	const ext = filename.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "js":
		case "jsx":
		case "mjs":
		case "cjs":
			return async () => {
				const { javascript } = await import("@codemirror/lang-javascript");
				return javascript({ jsx: true });
			};
		case "ts":
		case "tsx":
		case "mts":
		case "cts":
			return async () => {
				const { javascript } = await import("@codemirror/lang-javascript");
				return javascript({ jsx: true, typescript: true });
			};
		case "py":
			return async () => {
				const { python } = await import("@codemirror/lang-python");
				return python();
			};
		case "json":
			return async () => {
				const { json } = await import("@codemirror/lang-json");
				return json();
			};
		case "md":
		case "markdown":
			return async () => {
				const { markdown } = await import("@codemirror/lang-markdown");
				return markdown();
			};
		case "css":
		case "scss":
			return async () => {
				const { css } = await import("@codemirror/lang-css");
				return css();
			};
		case "html":
		case "htm":
			return async () => {
				const { html } = await import("@codemirror/lang-html");
				return html();
			};
		case "rs":
			return async () => {
				const { rust } = await import("@codemirror/lang-rust");
				return rust();
			};
		case "go":
			return async () => {
				const { go } = await import("@codemirror/lang-go");
				return go();
			};
		case "sh":
		case "bash":
		case "zsh":
			return async () => {
				const { StreamLanguage } = await import("@codemirror/language");
				const { shell } = await import("@codemirror/legacy-modes/mode/shell");
				return new (await import("@codemirror/language")).LanguageSupport(
					StreamLanguage.define(shell),
				);
			};
		default:
			return null;
	}
}

function FileViewer({
	filePath,
	onNavigate,
}: { filePath: string; onNavigate: (dir: string) => void }) {
	const editorRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<import("@codemirror/view").EditorView | null>(null);
	const [content, setContent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	// Fetch file content
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		setContent(null);

		(async () => {
			try {
				const response = await fetch(
					apiUrl(`/api/files/content?path=${encodeURIComponent(filePath)}`),
					{ signal: controller.signal },
				);
				if (!response.ok) {
					const body = await response.json().catch(() => null);
					const msg =
						body?.error?.message || `Failed to load file (${response.status})`;
					if (!controller.signal.aborted) setError(msg);
					return;
				}
				const text = await response.text();
				if (!controller.signal.aborted) setContent(text);
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") return;
				if (!controller.signal.aborted) setError("Failed to load file");
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();

		return () => {
			controller.abort();
		};
	}, [filePath]);

	// Create and manage the CodeMirror editor
	useEffect(() => {
		if (content === null || !editorRef.current) return;

		let destroyed = false;

		(async () => {
			const { EditorView, lineNumbers } = await import("@codemirror/view");
			const { EditorState } = await import("@codemirror/state");
			const { syntaxHighlighting, defaultHighlightStyle } = await import(
				"@codemirror/language"
			);
			const { oneDark } = await import("@codemirror/theme-one-dark");

			if (destroyed || !editorRef.current) return;

			const extensions = [
				EditorView.editable.of(false),
				EditorState.readOnly.of(true),
				lineNumbers(),
				syntaxHighlighting(defaultHighlightStyle),
				oneDark,
				EditorView.theme({
					"&": {
						fontSize: "13px",
						height: "100%",
					},
					".cm-scroller": {
						overflow: "auto",
						fontFamily:
							"'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace",
					},
					".cm-gutters": {
						backgroundColor: "var(--color-surface)",
						borderRight: "1px solid var(--color-border)",
					},
				}),
			];

			const state = EditorState.create({ doc: content, extensions });
			const view = new EditorView({
				state,
				parent: editorRef.current,
			});
			viewRef.current = view;

			// Lazy-load language support
			const loader = getLanguageLoader(filePath);
			if (loader) {
				try {
					const langSupport = await loader();
					if (!destroyed) {
						const newState = EditorState.create({
							doc: content,
							extensions: [...extensions, langSupport],
						});
						view.setState(newState);
					}
				} catch {
					// Language loading failed; plain text is fine
				}
			}
		})();

		return () => {
			destroyed = true;
			if (viewRef.current) {
				viewRef.current.destroy();
				viewRef.current = null;
			}
		};
	}, [content, filePath]);

	const filename = filePath.split("/").pop() || filePath;

	return (
		<div className="file-viewer">
			<header className="files-header">
				<button
					type="button"
					className="files-back-button"
					onClick={() => {
						// Navigate to parent directory
						const parts = filePath.split("/");
						const parentDir =
							parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
						onNavigate(parentDir);
					}}
					aria-label="Back to file tree"
				>
					<ArrowLeft size={18} />
				</button>
				<Breadcrumbs path={filePath} onNavigate={onNavigate} />
			</header>
			{loading && <div className="files-message">Loading {filename}...</div>}
			{error && <div className="files-error">{error}</div>}
			{content !== null && <div ref={editorRef} className="editor-container" />}
		</div>
	);
}

function Breadcrumbs({
	path,
	onNavigate,
}: { path: string; onNavigate: (dir: string) => void }) {
	const parts = path.split("/").filter(Boolean);

	return (
		<nav className="breadcrumbs" aria-label="File path">
			<button
				type="button"
				className="breadcrumb"
				onClick={() => onNavigate(".")}
			>
				root
			</button>
			{parts.map((part, i) => {
				const partPath = parts.slice(0, i + 1).join("/");
				const isLast = i === parts.length - 1;
				return (
					<span key={partPath} className="breadcrumb-segment">
						<ChevronRight size={14} className="breadcrumb-separator" />
						{isLast ? (
							<span className="breadcrumb breadcrumb-current">{part}</span>
						) : (
							<button
								type="button"
								className="breadcrumb"
								onClick={() => onNavigate(partPath)}
							>
								{part}
							</button>
						)}
					</span>
				);
			})}
		</nav>
	);
}

function TreeEntry({
	node,
	onToggle,
	onFileSelect,
	depth,
}: {
	node: TreeNode;
	onToggle: (path: string) => void;
	onFileSelect: (path: string) => void;
	depth: number;
}) {
	const handleClick = () => {
		if (node.type === "directory") {
			onToggle(node.path);
		} else {
			onFileSelect(node.path);
		}
	};

	return (
		<>
			<button
				type="button"
				className="tree-entry"
				onClick={handleClick}
				style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
			>
				<span className="tree-entry-icon">
					{node.type === "directory" ? (
						node.expanded ? (
							<FolderOpen size={16} />
						) : (
							<Folder size={16} />
						)
					) : (
						<File size={16} />
					)}
				</span>
				<span className="tree-entry-name">{node.name}</span>
				{node.type === "directory" && (
					<ChevronRight
						size={14}
						className={`tree-chevron ${node.expanded ? "tree-chevron-open" : ""}`}
					/>
				)}
			</button>
			{node.expanded && node.loading && (
				<div
					className="tree-loading"
					style={{ paddingLeft: `${(depth + 1) * 1.25 + 0.5}rem` }}
				>
					Loading...
				</div>
			)}
			{node.expanded &&
				node.children?.map((child) => (
					<TreeEntry
						key={child.path}
						node={child}
						onToggle={onToggle}
						onFileSelect={onFileSelect}
						depth={depth + 1}
					/>
				))}
		</>
	);
}

export function FilesPage() {
	const { request } = useApi();
	const [tree, setTree] = useState<TreeNode[]>([]);
	const treeRef = useRef<TreeNode[]>([]);
	treeRef.current = tree;
	const [viewingFile, setViewingFile] = useState<string | null>(null);
	const [rootLoading, setRootLoading] = useState(true);
	const [truncated, setTruncated] = useState(false);

	const fetchDirectory = useCallback(
		async (
			dirPath: string,
		): Promise<{ nodes: TreeNode[]; truncated: boolean }> => {
			const data = await request<DirListing>(
				`/api/files?path=${encodeURIComponent(dirPath)}`,
			);
			if (!data) return { nodes: [], truncated: false };
			return {
				nodes: data.entries.map((entry) => ({
					name: entry.name,
					path: dirPath === "." ? entry.name : `${dirPath}/${entry.name}`,
					type: entry.type,
					size: entry.size,
					expanded: false,
					loading: false,
				})),
				truncated: data.truncated,
			};
		},
		[request],
	);

	// Load root directory on mount
	useEffect(() => {
		(async () => {
			const { nodes, truncated: t } = await fetchDirectory(".");
			setTree(nodes);
			setTruncated(t);
			setRootLoading(false);
		})();
	}, [fetchDirectory]);

	const toggleDirectory = useCallback(
		async (dirPath: string) => {
			// Read current state from ref to avoid stale closures
			function findNode(nodes: TreeNode[]): TreeNode | null {
				for (const node of nodes) {
					if (node.path === dirPath) return node;
					if (node.children) {
						const found = findNode(node.children);
						if (found) return found;
					}
				}
				return null;
			}

			const target = findNode(treeRef.current);
			if (!target || target.type !== "directory") return;

			function updateNodes(nodes: TreeNode[]): TreeNode[] {
				return nodes.map((node) => {
					if (node.path === dirPath) {
						if (node.expanded) {
							return { ...node, expanded: false };
						}
						if (node.children) {
							return { ...node, expanded: true };
						}
						return { ...node, expanded: true, loading: true };
					}
					if (node.children) {
						return { ...node, children: updateNodes(node.children) };
					}
					return node;
				});
			}

			setTree((prev) => updateNodes(prev));

			if (!target.expanded && !target.children) {
				const { nodes: children } = await fetchDirectory(dirPath);

				setTree((prev) => {
					function setChildren(nodes: TreeNode[]): TreeNode[] {
						return nodes.map((n) => {
							if (n.path === dirPath) {
								return { ...n, children, loading: false };
							}
							if (n.children) {
								return { ...n, children: setChildren(n.children) };
							}
							return n;
						});
					}
					return setChildren(prev);
				});
			}
		},
		[fetchDirectory],
	);

	const ensureExpanded = useCallback(
		async (dirPath: string) => {
			function findNode(nodes: TreeNode[]): TreeNode | null {
				for (const node of nodes) {
					if (node.path === dirPath) return node;
					if (node.children) {
						const found = findNode(node.children);
						if (found) return found;
					}
				}
				return null;
			}

			const target = findNode(treeRef.current);
			if (!target || target.type !== "directory" || target.expanded) return;

			toggleDirectory(dirPath);
		},
		[toggleDirectory],
	);

	const handleNavigate = useCallback(
		(dir: string) => {
			setViewingFile(null);
			if (dir !== ".") {
				ensureExpanded(dir);
			}
		},
		[ensureExpanded],
	);

	if (viewingFile) {
		return <FileViewer filePath={viewingFile} onNavigate={handleNavigate} />;
	}

	return (
		<div className="files-page">
			<header className="files-header">
				<span className="files-header-title">Files</span>
			</header>
			<div className="file-tree">
				{rootLoading && <div className="files-message">Loading...</div>}
				{!rootLoading && tree.length === 0 && (
					<div className="files-message">No files found</div>
				)}
				{tree.map((node) => (
					<TreeEntry
						key={node.path}
						node={node}
						onToggle={toggleDirectory}
						onFileSelect={setViewingFile}
						depth={0}
					/>
				))}
				{truncated && (
					<div className="files-truncated">
						Not all entries are displayed. The directory contains more than
						1,000 items.
					</div>
				)}
			</div>
		</div>
	);
}
