import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, TFile, TFolder, setIcon, EventRef } from 'obsidian';
import * as d3 from 'd3';

// --- Utility: Debounce with trailing edge ---
function debounce(fn: () => void, delay: number): () => void {
	let timer: ReturnType<typeof setTimeout>;
	return () => {
		clearTimeout(timer);
		timer = setTimeout(fn, delay);
	};
}

export const VIEW_TYPE_TREEMAP = "digital-garden-treemap-view";

interface ExclusionRule {
	value: string;
	mode: 'path' | 'keyword' | 'extension';
}

interface TreemapSettings {
	showHeatmap: boolean;
	palette: 'garden' | 'nebula' | 'winter' | 'custom';
	baseColor: string;
	freshColor: string;
	growthColor: string;
	excludedFolders: ExclusionRule[]; // Upgraded to rules
	maxDepth: number;
	locale: 'en' | 'zh';
	sizingStrategy: 'chars' | 'equal';
	newFileDaysThreshold: number;
	showTitle: boolean;
}

const TRANSLATIONS = {
	en: {
		settings_title: 'Digital Garden Treemap Settings',
		language_label: 'Language / 语言',
		language_desc: 'Select the plugin display language.',
		show_heatmap_label: 'Show Heatmap',
		show_heatmap_desc: 'Color nodes based on their last modification time.',
		palette_label: 'Color Palette',
		palette_desc: 'Select a preset color scheme.',
		base_color_label: 'Base Color (Custom)',
		base_color_desc: 'Base container color (L1/L2 nodes).',
		fresh_color_label: 'Fresh Color (Custom)',
		fresh_color_desc: 'Color for recently modified files.',
		growth_color_label: 'Growth Color (Custom)',
		growth_color_desc: 'Color for older files.',
		max_depth_label: 'Maximum Depth',
		max_depth_desc: 'Control how many folder levels to display (3-6).',
		excluded_folders_label: 'Exclusion Rules',
		excluded_folders_desc: 'Add rules to filter out specific folders, keywords, or file types.',
		add_folder_btn: 'Add Rule',
		remove_btn: 'Remove',
		chars_unit: 'chars',
		node_level: 'Level',
		more_label: 'more',
		mode_path: 'Path',
		mode_keyword: 'Keyword',
		mode_extension: 'Ext',
		sizing_label: 'Sizing',
		sizing_chars: 'Chars',
		sizing_equal: 'Equal',
		legend_base: 'Folder',
		legend_fresh: 'New Docs',
		legend_growth: 'Old Docs',
		new_file_days_label: 'New File Threshold (Days)',
		new_file_days_desc: 'Days a file is considered new, blending smoothly into the base color.',
		toggle_title: 'Toggle Document Titles (Privacy)'
	},
	zh: {
		settings_title: '数字花园矩阵图设置',
		language_label: '语言 / Language',
		language_desc: '选择插件的界面语言。',
		show_heatmap_label: '启用热力图',
		show_heatmap_desc: '根据文档最后修改时间显示颜色深浅。',
		palette_label: '配色方案',
		palette_desc: '选择预设的色彩系统。',
		base_color_label: '基础颜色 (自定义)',
		base_color_desc: '容器节点 (L1/L2) 的基础颜色。',
		fresh_color_label: '新鲜颜色 (自定义)',
		fresh_color_desc: '最近修改文档显示的颜色。',
		growth_color_label: '成熟颜色 (自定义)',
		growth_color_desc: '历史较久文档显示的颜色。',
		max_depth_label: '最大显示深度',
		max_depth_desc: '控制文件夹层级的展示深度 (3-6层)。',
		excluded_folders_label: '排除规则',
		excluded_folders_desc: '添加规则以过滤特定路径、关键词或文件类型。',
		add_folder_btn: '添加规则',
		remove_btn: '移除',
		chars_unit: '字',
		node_level: '层级',
		more_label: '更多',
		mode_path: '路径',
		mode_keyword: '关键词',
		mode_extension: '后缀',
		sizing_label: '面积口径',
		sizing_chars: '按字数',
		sizing_equal: '按条目',
		legend_base: '文件夹',
		legend_fresh: '新文档',
		legend_growth: '旧文档',
		new_file_days_label: '新文件判定阈值 (天)',
		new_file_days_desc: '定义文档在此天数内呈现由新到旧的阶梯颜色褪变。',
		toggle_title: '切换文档标题显示 (隐私保护)'
	}
};

const DEFAULT_SETTINGS: TreemapSettings = {
	showHeatmap: true,
	palette: 'garden',
	baseColor: 'hsla(210, 10%, 40%, 0.4)',
	freshColor: 'hsla(145, 50%, 60%, 0.7)',
	growthColor: 'hsla(155, 40%, 45%, 0.6)',
	excludedFolders: [],
	maxDepth: 3,
	locale: 'en',
	sizingStrategy: 'chars',
	newFileDaysThreshold: 7,
	showTitle: true
}

interface TreemapNode {
	name: string;
	path: string;
	value?: number;
	chars?: number; // Real character count for display
	mtime?: number;
	children?: TreemapNode[];
	childCount?: number; // Added for container stats
}

export default class DigitalGardenTreemapPlugin extends Plugin {
	settings!: TreemapSettings;

	t(key: keyof typeof TRANSLATIONS['en']): string {
		const locale = this.settings.locale || 'en';
		return TRANSLATIONS[locale][key] || TRANSLATIONS['en'][key];
	}

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_TREEMAP,
			(leaf) => new TreemapView(leaf, this)
		);

		this.addRibbonIcon('layout-grid', 'Open digital garden treemap', () => {
			void this.activateView();
		});

		this.addSettingTab(new DigitalGardenSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Trigger refresh in all views with cache invalidation
		this.app.workspace.getLeavesOfType(VIEW_TYPE_TREEMAP).forEach(leaf => {
			if (leaf.view instanceof TreemapView) {
				leaf.view.invalidateCache();
				void leaf.view.refresh();
			}
		});
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_TREEMAP);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({
				type: VIEW_TYPE_TREEMAP,
				active: true,
			});
		}

		await workspace.revealLeaf(leaf);
	}

	onunload() {
	}
}

class TreemapView extends ItemView {
	plugin: DigitalGardenTreemapPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: DigitalGardenTreemapPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_TREEMAP;
	}

	getDisplayText() {
		return "Treemap";
	}

	private currentRootPath: string = "";

	// --- Performance: Data Cache ---
	private hierarchyCache: TreemapNode | null = null;
	private cacheValid = false;

	// --- Performance: Resize Debounce ---
	private resizeObserver: ResizeObserver | null = null;

	// --- Physics: Elastic Tooltip ---
	private tooltipEl: HTMLElement | null = null;
	private tooltipTargetX = 0;
	private tooltipTargetY = 0;
	private tooltipCurrentX = 0;
	private tooltipCurrentY = 0;
	private tooltipRafId = 0;
	private tooltipVisible = false;
	private tooltipIsRightAligned = false;

	// --- Vault Event References ---
	private vaultEventRefs: EventRef[] = [];

	/** Mark data cache as stale */
	invalidateCache() {
		this.cacheValid = false;
		this.hierarchyCache = null;
	}

	async onOpen(): Promise<void> {
		await Promise.resolve();
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.classList.add("treemap-view-container");

		// 1. Header for Controls (Correctly nested inside the view container)
		container.createDiv({ cls: "treemap-controls-container" });

		// 2. Content for Treemap
		const treemapContainer = container.createDiv({ cls: "treemap-container" });
		treemapContainer.classList.add("treemap-container-inner");

		// Debounced Resize Observer (prevent layout thrashing)
		const debouncedRefresh = debounce(() => {
			void this.refresh();
		}, 150);

		this.resizeObserver = new ResizeObserver(() => {
			debouncedRefresh();
		});
		this.resizeObserver.observe(treemapContainer);

		// Vault Event Listeners (incremental cache invalidation)
		const vault = this.app.vault;
		const onVaultStructureChange = debounce(() => {
			this.invalidateCache();
			void this.refresh();
		}, 300);

		this.vaultEventRefs = [
			vault.on('create', onVaultStructureChange),
			vault.on('delete', onVaultStructureChange),
			vault.on('rename', onVaultStructureChange),
			vault.on('modify', debounce(() => {
				// High-frequency: only invalidate, don't force re-render
				this.invalidateCache();
			}, 1000))
		];

		void this.renderTreemap(treemapContainer);
	}

	private renderControls(container: HTMLElement) {
		container.empty();
		const controls = container.createDiv({ cls: 'treemap-controls' });

		// 1. Breadcrumbs Section (Left)
		const breadcrumbs = controls.createDiv({ cls: 'treemap-breadcrumbs' });
		this.renderBreadcrumbs(breadcrumbs);

		const rightControls = controls.createDiv({ cls: 'treemap-controls-right' });

		// 2. Legend Section
		const legend = rightControls.createDiv({ cls: 'treemap-legend' });

		const createLegendItem = (colorType: 'base' | 'fresh' | 'growth', labelKey: string) => {
			const item = legend.createDiv({ cls: 'treemap-legend-item' });
			const dot = item.createDiv({ cls: 'legend-dot' });
			dot.setCssStyles({ backgroundColor: this.getEffectiveColor(colorType) });
			item.createSpan({ text: this.plugin.t(labelKey as keyof typeof TRANSLATIONS['en']) });
		};

		createLegendItem('fresh', 'legend_fresh');
		createLegendItem('growth', 'legend_growth');

		rightControls.createDiv({ cls: 'treemap-v-divider' });

		// Tool Group (Privacy + Sizing)
		const toolGroup = rightControls.createDiv({ cls: 'treemap-tool-group' });

		// Privacy Toggle
		const privacyToggle = toolGroup.createDiv({
			cls: `treemap-icon-btn ${!this.plugin.settings.showTitle ? 'is-active' : ''}`,
			attr: { 'aria-label': this.plugin.t('toggle_title') }
		});
		setIcon(privacyToggle, this.plugin.settings.showTitle ? 'eye' : 'eye-off');
		privacyToggle.onclick = async () => {
			this.plugin.settings.showTitle = !this.plugin.settings.showTitle;
			await this.plugin.saveSettings();
			void this.refresh();
		};

		// 3. Optimized Sizing Strategy Selector (Segmented Picker)
		const sizingWrapper = toolGroup.createDiv({ cls: 'treemap-segmented-control' });

		const createSegment = (value: 'chars' | 'equal', labelKey: string) => {
			const segment = sizingWrapper.createDiv({
				cls: `treemap-segment ${this.plugin.settings.sizingStrategy === value ? 'is-active' : ''}`,
				text: this.plugin.t(labelKey as keyof typeof TRANSLATIONS['en'])
			});

			segment.onclick = async () => {
				if (this.plugin.settings.sizingStrategy === value) return;

				this.plugin.settings.sizingStrategy = value;
				await this.plugin.saveSettings();

				sizingWrapper.querySelectorAll('.treemap-segment').forEach(s => s.classList.remove('is-active'));
				segment.classList.add('is-active');

				await this.refresh();
			};
		};

		createSegment('chars', 'sizing_chars');
		createSegment('equal', 'sizing_equal');
	}

	private renderBreadcrumbs(container: HTMLElement) {
		const segments = this.currentRootPath.split('/').filter(s => s);

		// Root Link
		const rootLink = container.createSpan({ cls: 'breadcrumb-item', text: 'Vault' });
		rootLink.onclick = () => {
			this.currentRootPath = "";
			this.invalidateCache();
			void this.refresh();
		};

		let currentPathAcc = "";
		segments.forEach((segment) => {
			container.createSpan({ text: ' / ', cls: 'breadcrumb-separator' });
			currentPathAcc += (currentPathAcc ? "/" : "") + segment;
			const pathRef = currentPathAcc;

			const link = container.createSpan({ cls: 'breadcrumb-item', text: segment });
			link.onclick = () => {
				this.currentRootPath = pathRef;
				this.invalidateCache();
				void this.refresh();
			};
		});
	}

	async refresh(): Promise<void> {
		await Promise.resolve();
		const container = this.containerEl.querySelector(".treemap-container") as HTMLElement;
		if (container) {
			container.empty();
			this.tooltipEl = null;
			this.tooltipVisible = false;
			if (this.tooltipRafId) {
				cancelAnimationFrame(this.tooltipRafId);
				this.tooltipRafId = 0;
			}
			void this.renderTreemap(container);
		}

		// Re-render controls to sync state
		const controlsContainer = this.containerEl.querySelector(".treemap-controls-container") as HTMLElement;
		if (controlsContainer) {
			this.renderControls(controlsContainer);
		}
	}

	async renderTreemap(container: HTMLElement) {
		const data = await this.buildHierarchy();
		const width = container.clientWidth || 800;
		const height = container.clientHeight || 600;

		const root = d3.hierarchy(data)
			.sum(d => d.value || 0)
			.sort((a, b) => (b.value || 0) - (a.value || 0));

		d3.treemap<TreemapNode>()
			.size([width, height])
			.paddingInner(4)
			.paddingOuter(4)
			.paddingTop(24)(root);

		const svg = d3.select(container)
			.append("svg")
			.attr("width", width)
			.attr("height", height)
			.style("font-family", "inherit");

		// Physics-based easing: cubic-out for natural deceleration
		const transition = d3.transition().duration(500).ease(d3.easeCubicOut);

		const nodes = svg.selectAll<SVGGElement, d3.HierarchyRectangularNode<TreemapNode>>("g")
			.data(root.descendants() as d3.HierarchyRectangularNode<TreemapNode>[])
			.join(
				enter => enter.append("g")
					.attr("transform", d => `translate(${d.x0},${d.y0})`)
					.style("opacity", 0)
					.call(enter => enter.transition(transition).style("opacity", 1)),
				update => update.call(update => update.transition(transition)
					.attr("transform", d => `translate(${d.x0},${d.y0})`)),
				exit => exit.call(exit => exit.transition(transition).style("opacity", 0).remove())
			);

		nodes.append("rect")
			.attr("width", d => Math.max(0, d.x1 - d.x0))
			.attr("height", d => Math.max(0, d.y1 - d.y0))
			.attr("rx", d => (d.depth > 0 && d.depth < 3) ? 4 : 0)
			.attr("fill", d => this.getNodeColor(d))
			.attr("stroke", d => (d.depth > 0 && d.depth < 3) ? "rgba(180, 180, 180, 0.6)" : "rgba(255, 255, 255, 0.05)")
			.attr("stroke-width", d => (d.depth > 0 && d.depth < 3) ? "0.8px" : "0.5px")
			.style("cursor", "pointer")
			.attr("class", d => this.getNodeClass(d))
			.on("mouseenter", (event, d) => {
				const isLeaf = !d.data.children || d.data.children.length === 0;
				const isMoreNode = d.data.path.endsWith('/_more');
				if (isLeaf && !isMoreNode) {
					this.showTooltip(event, d);
				}
			})
			.on("mousemove", (event) => {
				this.updateTooltipTarget(event);
			})
			.on("mouseleave", () => {
				this.hideTooltip();
			})
			.on("click", (event, d) => {
				if (d.data.children) {
					// Phase 3 Fix: Handle folder drill-down on the main rect
					event.stopPropagation();
					this.currentRootPath = d.data.path;
					this.invalidateCache();
					void this.refresh();
				} else if (d.data.path.endsWith('.md')) {
					// Handle file opening
					const file = this.app.vault.getAbstractFileByPath(d.data.path);
					if (file instanceof TFile) {
						void this.app.workspace.getLeaf().openFile(file);
					}
				}
			});

		// Optimize text rendering with foreignObject for perfect truncation
		nodes.filter(d => {
			const w = d.x1 - d.x0;
			const h = d.y1 - d.y0;
			return d.data.children ? (w > 60 && h > 25) : (w > 36 && h > 18);
		})
			.append("foreignObject")
			.attr("width", d => Math.max(0, d.x1 - d.x0))
			.attr("height", d => Math.max(0, d.y1 - d.y0))
			.style("pointer-events", "none") // Disable pointer events on the foreignObject itself
			.append("xhtml:div") // Append an HTML div inside the foreignObject
			.attr("class", d => `treemap-node-label-container ${d.data.children ? 'is-folder' : 'is-leaf'}`)
			.each((d, i, selection) => {
				const labelContainer = selection[i] as HTMLElement;
				const isFolder = !!d.data.children;
				const isMoreNode = d.data.path.endsWith('/_more');

				// Phase 3: Privacy blur — CSS class instead of text replacement
				const isPrivacyActive = !isFolder && !this.plugin.settings.showTitle && !isMoreNode;
				if (isPrivacyActive) {
					labelContainer.classList.add('is-privacy-blur');
				}

				const titleEl = labelContainer.createDiv({
					cls: "treemap-node-title",
					text: d.data.name,
					attr: { title: isPrivacyActive ? '' : d.data.name }
				});

				// Phase 3: Gradient fade truncation for leaf nodes
				if (!isFolder) {
					titleEl.classList.add('has-fade-truncation');
				}

				if (isFolder && (d.depth === 1 || d.depth === 2)) {
					labelContainer.createDiv({
						cls: "treemap-node-badge",
						text: String(d.data.childCount)
					});
				}

				// Phase 3: "More" node visual upgrade
				if (isMoreNode) {
					labelContainer.classList.add('is-more-indicator');
				}
			});

		// Apply non-interactive styling for "more" nodes
		nodes.filter(d => d.data.path.endsWith('/_more'))
			.style("pointer-events", "none")
			.style("opacity", "0.8");
	}

	// --- Tooltip System: Elastic Spring Physics ---

	private showTooltip(event: MouseEvent, d: d3.HierarchyRectangularNode<TreemapNode>) {
		if (!this.tooltipEl) {
			this.tooltipEl = document.body.createDiv({ cls: 'dg-tooltip is-hidden' });
		}

		this.tooltipEl.classList.remove('is-hidden');
		this.tooltipEl.empty();

		const displayName = (!d.data.children && !this.plugin.settings.showTitle) ? '***' : d.data.name;

		this.tooltipEl.createDiv({ cls: 'dg-tooltip-title', text: displayName });
		const meta = this.tooltipEl.createDiv({ cls: 'dg-tooltip-meta' });
		meta.createSpan({ text: `${d.data.chars?.toLocaleString() || 0} ${this.plugin.t('chars_unit')}` });
		meta.createSpan({
			text: `${this.plugin.t('node_level')} ${d.depth}`,
			cls: 'is-muted'
		});

		// Initialize position instantly on first show (no lag from zero)
		const offset = 12;
		const winWidth = window.innerWidth;
		this.tooltipIsRightAligned = event.clientX > winWidth / 2;

		if (this.tooltipIsRightAligned) {
			this.tooltipTargetX = winWidth - event.clientX + offset;
		} else {
			this.tooltipTargetX = event.clientX + offset;
		}
		this.tooltipTargetY = event.clientY + offset;
		this.tooltipCurrentX = this.tooltipTargetX;
		this.tooltipCurrentY = this.tooltipTargetY;
		this.tooltipVisible = true;

		this.applyTooltipPosition();
		this.startTooltipAnimation();
	}

	private updateTooltipTarget(event: MouseEvent) {
		if (!this.tooltipVisible) return;
		const offset = 12;
		const winWidth = window.innerWidth;

		this.tooltipIsRightAligned = event.clientX > winWidth / 2;

		if (this.tooltipIsRightAligned) {
			this.tooltipTargetX = winWidth - event.clientX + offset;
		} else {
			this.tooltipTargetX = event.clientX + offset;
		}
		this.tooltipTargetY = event.clientY + offset;
	}

	private startTooltipAnimation() {
		if (this.tooltipRafId) return;

		const animate = () => {
			if (!this.tooltipVisible) {
				this.tooltipRafId = 0;
				return;
			}

			// Spring-like interpolation (0.12 = soft, buttery trailing)
			const lerpFactor = 0.12;
			this.tooltipCurrentX += (this.tooltipTargetX - this.tooltipCurrentX) * lerpFactor;
			this.tooltipCurrentY += (this.tooltipTargetY - this.tooltipCurrentY) * lerpFactor;

			this.applyTooltipPosition();
			this.tooltipRafId = requestAnimationFrame(animate);
		};

		this.tooltipRafId = requestAnimationFrame(animate);
	}

	private applyTooltipPosition() {
		if (!this.tooltipEl) return;

		if (this.tooltipIsRightAligned) {
			this.tooltipEl.addClass('is-right-aligned');
			this.tooltipEl.setCssProps({
				'--tooltip-y': `${this.tooltipCurrentY}px`,
				'--tooltip-right-x': `${this.tooltipCurrentX}px`
			});
		} else {
			this.tooltipEl.removeClass('is-right-aligned');
			this.tooltipEl.setCssProps({
				'--tooltip-y': `${this.tooltipCurrentY}px`,
				'--tooltip-x': `${this.tooltipCurrentX}px`
			});
		}
	}

	private hideTooltip() {
		this.tooltipVisible = false;
		if (this.tooltipRafId) {
			cancelAnimationFrame(this.tooltipRafId);
			this.tooltipRafId = 0;
		}
		if (this.tooltipEl) {
			this.tooltipEl.classList.add('is-hidden');
		}
	}

	private getNodeColor(d: d3.HierarchyRectangularNode<TreemapNode>): string {
		if (d.data.children && d.data.children.length > 0) return "rgba(255, 255, 255, 0.05)";

		if (!this.plugin.settings.showHeatmap) {
			return this.getEffectiveColor('base');
		}

		const now = Date.now();
		const mtime = d.data.mtime || 0;
		const diffDays = (now - mtime) / (1000 * 60 * 60 * 24);

		const threshold = this.plugin.settings.newFileDaysThreshold || 7;
		if (diffDays >= threshold) return this.getEffectiveColor('base');

		const step = Math.floor(diffDays);
		const t = step / threshold;
		const fresh = this.getEffectiveColor('fresh');
		const growth = this.getEffectiveColor('growth');
		const base = this.getEffectiveColor('base');

		// 保证 t 在 0 到 1 之间
		const clampedT = Math.max(0, Math.min(1, t));

		// HCL interpolation: perceptually uniform brightness across the gradient
		if (clampedT < 0.5) {
			return d3.interpolateHcl(fresh, growth)(clampedT * 2);
		} else {
			return d3.interpolateHcl(growth, base)((clampedT - 0.5) * 2);
		}
	}

	private getEffectiveColor(type: 'base' | 'fresh' | 'growth'): string {
		const { palette, baseColor, freshColor, growthColor } = this.plugin.settings;

		if (palette === 'custom') {
			if (type === 'base') return baseColor;
			if (type === 'fresh') return freshColor;
			return growthColor;
		}

		const presets: Record<Exclude<TreemapSettings['palette'], 'custom'>, { base: string, fresh: string, growth: string }> = {
			garden: { base: 'hsla(210, 10%, 40%, 0.4)', fresh: 'hsla(145, 50%, 60%, 0.7)', growth: 'hsla(155, 40%, 45%, 0.6)' },
			nebula: { base: 'hsla(260, 20%, 30%, 0.5)', fresh: 'hsla(300, 60%, 60%, 0.8)', growth: 'hsla(280, 50%, 45%, 0.7)' },
			winter: { base: 'hsla(200, 15%, 85%, 0.3)', fresh: 'hsla(210, 80%, 75%, 0.8)', growth: 'hsla(205, 40%, 60%, 0.6)' }
		};

		return presets[palette as keyof typeof presets][type];
	}

	private getNodeClass(d: d3.HierarchyRectangularNode<TreemapNode>): string {
		const classes = ["treemap-node"];
		if (d.data.children && d.data.children.length > 0) return classes.join(" ");

		const now = Date.now();
		const mtime = d.data.mtime || 0;
		const diffDays = (now - mtime) / (1000 * 60 * 60 * 24);

		if (diffDays < 1) classes.push("garden-breathing");
		return classes.join(" ");
	}

	async buildHierarchy(): Promise<TreemapNode> {
		// Return cached data if still valid
		if (this.cacheValid && this.hierarchyCache) {
			return this.hierarchyCache;
		}

		let targetFolder: TFolder | null = null;
		if (this.currentRootPath) {
			const abstractFile = this.app.vault.getAbstractFileByPath(this.currentRootPath);
			if (abstractFile instanceof TFolder) {
				targetFolder = abstractFile;
			}
		}

		if (!targetFolder) {
			targetFolder = this.app.vault.getRoot();
			this.currentRootPath = "";
		}

		const result = await this.processFolder(targetFolder, 0);

		// Store in cache
		this.hierarchyCache = result;
		this.cacheValid = true;

		return result;
	}

	private async processFolder(folder: TFolder, depth: number): Promise<TreemapNode> {
		const rules = this.plugin.settings.excludedFolders || [];
		const maxDepth = this.plugin.settings.maxDepth;

		const node: TreemapNode = {
			name: folder.isRoot() ? "Root" : folder.name,
			path: folder.path,
			children: [],
			childCount: 0
		};

		// Safety exit for depth
		if (depth >= maxDepth) return node;

		const mdFiles: TFile[] = [];
		const directSubFolders: TFolder[] = [];

		for (const child of folder.children) {
			const isExcluded = rules.some(rule => {
				const val = rule.value.toLowerCase();
				const path = child.path.toLowerCase();

				if (rule.mode === 'path') {
					return path === val || path.startsWith(val + '/');
				} else if (rule.mode === 'keyword') {
					return path.includes(val);
				} else if (rule.mode === 'extension') {
					if (child instanceof TFile) {
						return child.extension.toLowerCase() === val.replace('.', '');
					}
				}
				return false;
			});

			if (isExcluded) continue;

			if (child instanceof TFile && child.extension === 'md') {
				mdFiles.push(child);
			} else if (child instanceof TFolder) {
				directSubFolders.push(child);
			}
		}

		// 1. Process Folders as nested containers (up to depth maxDepth - 1)
		if (depth < maxDepth - 1) {
			for (const sub of directSubFolders) {
				const childNode = await this.processFolder(sub, depth + 1);
				if ((childNode.children && childNode.children.length > 0) || (childNode.value && childNode.value > 0)) {
					node.children?.push(childNode);
				}
			}
		}

		// 2. Process Files as leaf nodes
		const strategy = this.plugin.settings.sizingStrategy;
		for (const file of mdFiles) {
			const content = await this.app.vault.cachedRead(file);
			const realChars = Math.max(1, content.length);
			let value = 1;

			if (strategy === 'chars') {
				value = realChars;
			}

			node.children?.push({
				name: file.basename,
				path: file.path,
				value: value,
				chars: realChars,
				mtime: file.stat.mtime
			});
		}

		// 3. Breadth limit at LEAF Level: Only in 'chars' mode
		if (strategy === 'chars' && depth === maxDepth - 1 && node.children && node.children.length > 20) {
			const sorted = node.children.sort((a, b) => {
				const valA = a.children ? (a.childCount || 0) * 100 : (a.value || 0);
				const valB = b.children ? (b.childCount || 0) * 100 : (b.value || 0);
				return valB - valA;
			});
			const truncated = sorted.slice(0, 19);
			const remainingCount = sorted.length - 19;
			const moreText = this.plugin.settings.locale === 'zh' ? `+${remainingCount} 更多` : `+${remainingCount} more`;

			truncated.push({
				name: moreText,
				path: node.path + "/_more",
				value: 1000,
				chars: 0,
				mtime: Date.now()
			});
			node.children = truncated;
		}

		// 4. Calculate total child count recursively for the badge
		let total = 0;
		const countRecursive = (n: TreemapNode) => {
			if (n.children && n.children.length > 0) {
				n.children.forEach(countRecursive);
			} else if (n.value) {
				total++;
			}
		};
		node.children?.forEach(countRecursive);
		node.childCount = total;

		return node;
	}

	async onClose() {
		// Cleanup tooltip
		if (this.tooltipEl) {
			this.tooltipEl.remove();
			this.tooltipEl = null;
		}
		if (this.tooltipRafId) {
			cancelAnimationFrame(this.tooltipRafId);
			this.tooltipRafId = 0;
		}

		// Disconnect resize observer
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}

		// Unregister vault events
		this.vaultEventRefs.forEach(ref => this.app.vault.offref(ref));
		this.vaultEventRefs = [];

		// Clear cache
		this.invalidateCache();
	}
}

class DigitalGardenSettingTab extends PluginSettingTab {
	plugin: DigitalGardenTreemapPlugin;

	constructor(app: App, plugin: DigitalGardenTreemapPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName(this.plugin.t('settings_title')).setHeading();

		new Setting(containerEl)
			.setName(this.plugin.t('language_label'))
			.setDesc(this.plugin.t('language_desc'))
			.addDropdown(dropdown => dropdown
				.addOption('en', 'English')
				.addOption('zh', '简体中文')
				.setValue(this.plugin.settings.locale)
				.onChange(async (value: string) => {
					this.plugin.settings.locale = value as 'en' | 'zh';
					await this.plugin.saveSettings();
					this.display(); // Refresh tab to show new language
				}));

		new Setting(containerEl)
			.setName(this.plugin.t('show_heatmap_label'))
			.setDesc(this.plugin.t('show_heatmap_desc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showHeatmap)
				.onChange(async (value) => {
					this.plugin.settings.showHeatmap = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(this.plugin.t('palette_label'))
			.setDesc(this.plugin.t('palette_desc'))
			.addDropdown(dropdown => dropdown
				.addOption('garden', 'Digital garden (green)')
				.addOption('nebula', 'Midnight nebula (purple)')
				.addOption('winter', 'Nordic winter (blue)')
				.addOption('custom', this.plugin.settings.locale === 'zh' ? '自定义颜色' : 'Custom Color')
				.setValue(this.plugin.settings.palette)
				.onChange(async (value) => {
					this.plugin.settings.palette = value as TreemapSettings['palette'];
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.palette === 'custom') {
			new Setting(containerEl)
				.setName(this.plugin.t('fresh_color_label'))
				.setDesc(this.plugin.t('fresh_color_desc'))
				.addColorPicker(color => color
					.setValue(this.plugin.settings.freshColor)
					.onChange(async (value) => {
						this.plugin.settings.freshColor = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(this.plugin.t('growth_color_label'))
				.setDesc(this.plugin.t('growth_color_desc'))
				.addColorPicker(color => color
					.setValue(this.plugin.settings.growthColor)
					.onChange(async (value) => {
						this.plugin.settings.growthColor = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName(this.plugin.t('base_color_label'))
				.setDesc(this.plugin.t('base_color_desc'))
				.addColorPicker(color => color
					.setValue(this.plugin.settings.baseColor)
					.onChange(async (value) => {
						this.plugin.settings.baseColor = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName(this.plugin.t('max_depth_label'))
			.setDesc(this.plugin.t('max_depth_desc'))
			.addSlider(slider => slider
				.setLimits(3, 6, 1)
				.setValue(this.plugin.settings.maxDepth)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxDepth = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(this.plugin.t('new_file_days_label'))
			.setDesc(this.plugin.t('new_file_days_desc'))
			.addSlider(slider => slider
				.setLimits(1, 30, 1)
				.setValue(this.plugin.settings.newFileDaysThreshold || 7)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.newFileDaysThreshold = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(this.plugin.t('excluded_folders_label'))
			.setDesc(this.plugin.t('excluded_folders_desc'))
			.addButton(btn => btn
				.setButtonText(this.plugin.t('add_folder_btn'))
				.setCta()
				.onClick(async () => {
					this.plugin.settings.excludedFolders.push({ value: '', mode: 'path' });
					await this.plugin.saveSettings();
					this.display();
				}));

		const excludedContainer = containerEl.createDiv({ cls: 'excluded-folders-list' });

		this.plugin.settings.excludedFolders.forEach((rule, index) => {
			new Setting(excludedContainer)
				.addDropdown(dropdown => dropdown
					.addOption('path', this.plugin.t('mode_path'))
					.addOption('keyword', this.plugin.t('mode_keyword'))
					.addOption('extension', this.plugin.t('mode_extension'))
					.setValue(rule.mode)
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders[index].mode = value as ExclusionRule['mode'];
						await this.plugin.saveSettings();
					}))
				.addText(text => text
					.setPlaceholder(rule.mode === 'extension' ? 'e.g. canvas' : 'path/to/folder')
					.setValue(rule.value)
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders[index].value = value;
						await this.plugin.saveSettings();
					}))
				.addExtraButton(btn => btn
					.setIcon('trash')
					.setTooltip(this.plugin.t('remove_btn'))
					.onClick(async () => {
						this.plugin.settings.excludedFolders.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					}));
		});
	}
}
