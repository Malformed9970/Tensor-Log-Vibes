// DOM Elements
const fileInput = document.getElementById('logFileInput');
const fileCountIndicator = document.getElementById('fileCountIndicator');
const tableContainer = document.getElementById('tableContainer');
const eventTableBody = document.getElementById('eventTableBody');
const emptyState = document.getElementById('emptyState');
const loader = document.getElementById('loader');
const parseProgress = document.getElementById('parseProgress');

const globalSearch = document.getElementById('globalSearch');
const showingCount = document.getElementById('showingCount');
const totalCount = document.getElementById('totalCount');

const minTimeInput = document.getElementById('minTimeInput');
const maxTimeInput = document.getElementById('maxTimeInput');
const regexToggle = document.getElementById('regexToggle');

const customColInput = document.getElementById('customColInput');
const addCustomColBtn = document.getElementById('addCustomColBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const tableHeaderRow = document.getElementById('tableHeaderRow');

const eventTypeDropdown = document.getElementById('eventTypeDropdown');
const eventTypeSelect = document.getElementById('eventTypeSelectText');
const eventTypeSearch = document.getElementById('eventTypeSearch');
const eventTypeOptionsContainer = document.getElementById('eventTypeOptionsContainer');

const entityDropdown = document.getElementById('entityDropdown');
const entitySelect = document.getElementById('entitySelectText');
const entitySearch = document.getElementById('entitySearch');
const entityOptionsContainer = document.getElementById('entityOptionsContainer');

const dataModal = document.getElementById('dataModal');
const closeModal = document.getElementById('closeModal');
const modalCodePayload = document.getElementById('modalCodePayload');

// Application State
let parsedEvents = [];
let filteredEvents = [];
let pinnedEvents = new Set();
let uniqueEventTypes = new Set();
let uniqueEntities = new Set(); // names and IDs combined
let playerEntities = new Set(); // Players identified by ContentID: 0

let activeFilters = {
    search: '',
    useRegex: false,
    types: new Set(),
    entities: new Set(),
    minTime: null,
    maxTime: null
};

let customColumns = []; // Array of pinned payload keys
let baseColumns = ['pin', 'file', 'time', 'timeDelta', 'realTime', 'realTimeDelta', 'type', 'source', 'target', 'details'];
let columnOrder = [...baseColumns];
let tableLayoutLocked = false;
let columnWidthsMap = {};

// --- Initialization ---
function init() {
    setupEventListeners();
}

function setupEventListeners() {
    fileInput.addEventListener('change', handleFilesSelect);

    // Global Drag and Drop
    document.body.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.add('dragover-active');
    });

    document.body.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.target === document.body || e.clientY <= 0 || e.clientX <= 0 || (e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)) {
            document.body.classList.remove('dragover-active');
        }
    });

    document.body.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.remove('dragover-active');
        handleFilesSelect(e);
    });

    globalSearch.addEventListener('input', debounce(() => {
        activeFilters.search = globalSearch.value.toLowerCase();
        applyFiltersAndRender();
    }, 300));

    minTimeInput.addEventListener('input', debounce(() => {
        activeFilters.minTime = minTimeInput.value === '' ? null : parseFloat(minTimeInput.value);
        applyFiltersAndRender();
    }, 300));

    maxTimeInput.addEventListener('input', debounce(() => {
        activeFilters.maxTime = maxTimeInput.value === '' ? null : parseFloat(maxTimeInput.value);
        applyFiltersAndRender();
    }, 300));

    regexToggle.addEventListener('change', () => {
        activeFilters.useRegex = regexToggle.checked;
        applyFiltersAndRender();
    });

    addCustomColBtn.addEventListener('click', () => {
        const colName = customColInput.value.trim();
        if (colName && !customColumns.includes(colName)) {
            customColumns.push(colName);
            columnOrder.splice(columnOrder.length - 1, 0, `custom_${colName}`); // Insert before details
            customColInput.value = '';
            renderTableHeaders();
            renderTable();
        }
    });

    exportCsvBtn.addEventListener('click', exportToCsv);
    exportJsonBtn.addEventListener('click', exportToJson);

    // Custom Select Toggle logic
    document.addEventListener('click', closeAllSelects);

    eventTypeSelect.addEventListener('click', function (e) {
        e.stopPropagation();
        closeAllSelects(this);
        eventTypeDropdown.classList.toggle('select-hide');
        this.classList.toggle('select-arrow-active');
    });

    entitySelect.addEventListener('click', function (e) {
        e.stopPropagation();
        closeAllSelects(this);
        entityDropdown.classList.toggle('select-hide');
        this.classList.toggle('select-arrow-active');
    });

    // Prevent dropdown from closing when interacting inside
    eventTypeDropdown.addEventListener('click', e => e.stopPropagation());
    entityDropdown.addEventListener('click', e => e.stopPropagation());

    // Added Action Handlers
    const selectPlayersBtn = document.getElementById('selectPlayersBtn');
    if (selectPlayersBtn) {
        selectPlayersBtn.addEventListener('click', e => {
            e.stopPropagation();
            const container = document.getElementById('entityOptionsContainer');
            const checkboxes = container.querySelectorAll('.select-item input[type="checkbox"]');

            activeFilters.entities.clear();

            checkboxes.forEach(cb => {
                // If it is a known player, check it
                if (playerEntities.has(cb.value)) {
                    cb.checked = true;
                    activeFilters.entities.add(cb.value);
                } else {
                    cb.checked = false;
                }
            });

            updateSelectText();
            applyFiltersAndRender();
        });
    }

    const selectNonPlayersBtn = document.getElementById('selectNonPlayersBtn');
    if (selectNonPlayersBtn) {
        selectNonPlayersBtn.addEventListener('click', e => {
            e.stopPropagation();
            const container = document.getElementById('entityOptionsContainer');
            const checkboxes = container.querySelectorAll('.select-item input[type="checkbox"]');

            activeFilters.entities.clear();

            checkboxes.forEach(cb => {
                if (!playerEntities.has(cb.value)) {
                    cb.checked = true;
                    activeFilters.entities.add(cb.value);
                } else {
                    cb.checked = false;
                }
            });

            updateSelectText();
            applyFiltersAndRender();
        });
    }

    // Search within dropdowns
    eventTypeSearch.addEventListener('input', (e) => filterDropdownOptions(e.target.value, eventTypeOptionsContainer));
    entitySearch.addEventListener('input', (e) => filterDropdownOptions(e.target.value, entityOptionsContainer));

    // Virtual Scrolling Hook
    let isScrolling = false;
    tableContainer.addEventListener('scroll', () => {
        if (!isScrolling) {
            window.requestAnimationFrame(() => {
                renderVirtualTable();
                isScrolling = false;
            });
            isScrolling = true;
        }
    });

    closeModal.addEventListener('click', () => dataModal.classList.add('hidden'));
    window.addEventListener('click', (e) => {
        if (e.target === dataModal) dataModal.classList.add('hidden');
    });

    renderTableHeaders();
}

function closeAllSelects(elmnt) {
    const x = document.getElementsByClassName("select-items");
    const y = document.getElementsByClassName("select-selected");
    for (let i = 0; i < y.length; i++) {
        if (elmnt !== y[i]) {
            y[i].classList.remove("select-arrow-active");
        }
    }
    for (let i = 0; i < x.length; i++) {
        if (elmnt !== x[i].previousElementSibling) {
            x[i].classList.add("select-hide");
        }
    }
}

function filterDropdownOptions(searchTerm, container) {
    const term = searchTerm.toLowerCase();
    const items = container.querySelectorAll('.select-item');
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        if (text.includes(term)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

// --- Web Worker Blob ---
const workerFunction = function () {
    function isNumericOrHex(str) {
        return /^[0-9A-Fa-f]+$/.test(str);
    }

    self.onmessage = async function (e) {
        const files = e.data.files;
        let parsedEvents = [];
        let uniqueEventTypes = new Set();
        let uniqueEntities = new Set();
        let playerEntities = new Set();

        let totalSize = 0;
        for (let i = 0; i < files.length; i++) totalSize += files[i].size;
        let processedSize = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const text = await file.text();
            const lines = text.split('\n');
            const fileName = file.name;

            let currentMultilineEvent = null;
            let multilinePayload = [];

            for (let j = 0; j < lines.length; j++) {
                const line = lines[j].trim();

                if (j % 10000 === 0) {
                    let pct = Math.floor(((processedSize + (j / lines.length) * file.size) / totalSize) * 100);
                    self.postMessage({ type: 'progress', pct });
                }

                if (!line) continue;

                if (currentMultilineEvent) {
                    multilinePayload.push(line);
                    if (line === '}') {
                        currentMultilineEvent.payloadRaw = multilinePayload.join('\n');
                        parsedEvents.push(currentMultilineEvent);
                        currentMultilineEvent = null;
                        multilinePayload = [];
                    }
                    continue;
                }

                let singleMatch = line.match(/^\[(.*?)\]\s+/);
                let doubleMatch = line.match(/^\[.*?\]\s*\[(.*?)\]\s+/);

                let time = '';
                let realTime = '';
                let content = line;

                if (doubleMatch) {
                    time = singleMatch ? singleMatch[1] : '';
                    realTime = doubleMatch[1];
                    content = line.substring(doubleMatch[0].length);
                } else if (singleMatch) {
                    time = singleMatch[1];
                    realTime = time; // Fallback so realTime isn't completely empty
                    content = line.substring(singleMatch[0].length);
                }

                if (content.startsWith('| ')) {
                    content = content.substring(2);
                }

                const parts = content.split(' | ');
                let eventType = parts[0].trim();

                if (eventType.startsWith('|')) eventType = eventType.substring(1).trim();

                if (eventType.startsWith('AnyoneCore Log:')) {
                    eventType = 'AnyoneCore Log';
                } else if (eventType.startsWith('[AnyoneCore] Combat started')) {
                    eventType = '[AnyoneCore] Combat started';
                } else if (eventType.startsWith('[TimelineSync') || eventType.startsWith('TimelineSync')) {
                    eventType = 'TimelineSync';
                } else if (eventType.startsWith('Queueing reaction')) {
                    eventType = 'Queueing reaction';
                } else if (eventType.startsWith('Executed reaction')) {
                    eventType = 'Executed reaction';
                } else if (eventType.startsWith('Dequeueing stale reaction')) {
                    eventType = 'Dequeueing action';
                } else if (eventType.startsWith('Loaded timeline profile')) {
                    eventType = 'Loaded timeline profile';
                } else if (eventType.startsWith('Loading timeline profile')) {
                    eventType = 'Loading timeline profile';
                } else if (eventType.startsWith('Loading inherited timeline profile')) {
                    eventType = 'Loading inherited timeline profile';
                }

                let eventObj = {
                    id: parsedEvents.length,
                    file: fileName,
                    time: time,
                    realTime: realTime,
                    type: eventType,
                    sourceName: '',
                    sourceId: '',
                    targetName: '',
                    targetId: '',
                    payload: {},
                    payloadRaw: line,
                    isMultiline: false
                };

                uniqueEventTypes.add(eventType);

                for (let kIdx = 1; kIdx < parts.length; kIdx++) {
                    const pair = parts[kIdx];
                    const colonIdx = pair.indexOf(':');

                    if (colonIdx > -1) {
                        const k = pair.substring(0, colonIdx).trim();
                        const v = pair.substring(colonIdx + 1).trim();
                        eventObj.payload[k] = v;

                        let cleanV = v.replace(/^"|"$/g, '');
                        if (k === 'Entity Name' || k === 'Caster Name' || k === 'Source Name' || k === 'Owner Name') {
                            if (cleanV !== 'nil' && cleanV !== '') eventObj.sourceName = cleanV;
                        }
                        if (k === 'Entity ID' || k === 'Caster ID' || k === 'Source ID' || k === 'Owner ID') {
                            if (v !== 'nil' && v !== '0' && isNumericOrHex(v)) eventObj.sourceId = v;
                        }

                        if (k === 'Target Name' || k === 'Entity 2 Name' || k === 'New Target Name' || k === 'Old Target Name' || k === 'Target Ent') {
                            if (cleanV !== 'nil' && cleanV !== '' && cleanV !== 'Unk') eventObj.targetName = cleanV;
                        }
                        if (k === 'Target ID' || k === 'Entity 2 ID' || k === 'New Target ID' || k === 'Old Target ID') {
                            if (v !== 'nil' && v !== '0' && isNumericOrHex(v)) eventObj.targetId = v;
                        }

                        if (eventObj.sourceName) uniqueEntities.add(eventObj.sourceName);
                        if (eventObj.targetName) uniqueEntities.add(eventObj.targetName);
                    }
                }

                for (let key in eventObj.payload) {
                    if (key.endsWith('ContentID') && eventObj.payload[key] === '0') {
                        let prefix = key.split(' ')[0];
                        let pName = eventObj.payload[`${prefix} Name`];
                        let pId = eventObj.payload[`${prefix} ID`];
                        if (pName) playerEntities.add(pName);
                        if (pId) playerEntities.add(pId);
                    }
                }

                if (j + 1 < lines.length && lines[j + 1].trim() === '{') {
                    eventObj.isMultiline = true;
                    currentMultilineEvent = eventObj;
                    multilinePayload = [];
                } else {
                    parsedEvents.push(eventObj);
                }
            }
            processedSize += file.size;
            self.postMessage({ type: 'progress', pct: Math.floor((processedSize / totalSize) * 100) });
        }

        self.postMessage({
            type: 'done',
            parsedEvents,
            uniqueEventTypes: Array.from(uniqueEventTypes),
            uniqueEntities: Array.from(uniqueEntities),
            playerEntities: Array.from(playerEntities)
        });
    };
};

// --- File Handling & Parsing ---
async function handleFilesSelect(event) {
    const files = event.dataTransfer ? event.dataTransfer.files : event.target.files;
    if (!files || files.length === 0) return;

    fileCountIndicator.textContent = `${files.length} file(s) loaded`;
    parsedEvents = [];
    pinnedEvents.clear();
    uniqueEventTypes.clear();
    uniqueEntities.clear();
    playerEntities.clear();

    showLoader(true);
    parseProgress.textContent = `0%`;

    const blob = new Blob([`(${workerFunction.toString()})()`], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    worker.onmessage = function (e) {
        if (e.data.type === 'progress') {
            parseProgress.textContent = `${e.data.pct}%`;
        } else if (e.data.type === 'done') {
            parsedEvents = e.data.parsedEvents;
            uniqueEventTypes = new Set(e.data.uniqueEventTypes);
            uniqueEntities = new Set(e.data.uniqueEntities);
            playerEntities = new Set(e.data.playerEntities);

            filteredEvents = [...parsedEvents];
            populateDropdowns();
            applyFiltersAndRender();
            showLoader(false);
            renderTimeline();

            worker.terminate();
            URL.revokeObjectURL(workerUrl);
        }
    };

    worker.postMessage({ files: Array.from(files) });
}



// --- UI Updates ---
function populateDropdowns() {
    eventTypeOptionsContainer.innerHTML = '';
    entityOptionsContainer.innerHTML = '';

    activeFilters.types.clear();
    activeFilters.entities.clear();
    updateSelectText();

    // Event Types
    Array.from(uniqueEventTypes).sort().forEach(type => {
        if (!type) return;
        createCheckboxItem(type, eventTypeOptionsContainer, activeFilters.types);
    });

    // Entities
    Array.from(uniqueEntities).sort().forEach(ent => {
        createCheckboxItem(ent, entityOptionsContainer, activeFilters.entities);
    });
}

function createCheckboxItem(value, container, filterSet) {
    const label = document.createElement('label');
    label.className = 'select-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = value;
    checkbox.onchange = function () {
        if (this.checked) filterSet.add(value);
        else filterSet.delete(value);

        updateSelectText();
        applyFiltersAndRender();
    };

    const span = document.createElement('span');
    span.textContent = value;
    span.title = value; // tooltip for long names

    label.appendChild(checkbox);
    label.appendChild(span);
    container.appendChild(label);
}

function updateSelectText() {
    if (activeFilters.types.size === 0) {
        eventTypeSelect.textContent = "Event Types: All";
    } else if (activeFilters.types.size === 1) {
        eventTypeSelect.textContent = Array.from(activeFilters.types)[0];
    } else {
        eventTypeSelect.textContent = `Event Types: ${activeFilters.types.size} selected`;
    }

    if (activeFilters.entities.size === 0) {
        entitySelect.textContent = "Entities: All";
    } else if (activeFilters.entities.size === 1) {
        entitySelect.textContent = Array.from(activeFilters.entities)[0];
    } else {
        entitySelect.textContent = `Entities: ${activeFilters.entities.size} selected`;
    }
}

function applyFiltersAndRender() {
    // Pre-compile Regex if needed to avoid O(N) compilations
    let compiledRegex = null;
    let fallbackTextTerm = '';

    if (activeFilters.search) {
        if (activeFilters.useRegex) {
            try {
                compiledRegex = new RegExp(activeFilters.search, 'i');
            } catch (e) {
                fallbackTextTerm = activeFilters.search.toLowerCase(); // fallback to string
            }
        } else {
            fallbackTextTerm = activeFilters.search.toLowerCase();
        }
    }

    filteredEvents = parsedEvents.filter(ev => {
        // Type filter (Multi)
        if (activeFilters.types.size > 0 && !activeFilters.types.has(ev.type)) return false;

        // Entity Filter (Multi)
        if (activeFilters.entities.size > 0) {
            const evEntities = [ev.sourceName, ev.sourceId, ev.targetName, ev.targetId].filter(Boolean);
            let hasEntity = evEntities.some(filterEnt => activeFilters.entities.has(filterEnt));

            if (!hasEntity) {
                // Only search payload for exact IDs or Names, avoiding random payload properties
                const entityKeys = ['Entity Name', 'Caster Name', 'Entity ID', 'Caster ID', 'Target Name', 'Entity 2 Name', 'Target ID', 'Entity 2 ID', 'Owner Name', 'Owner ID'];

                for (let key in ev.payload) {
                    if (entityKeys.some(k => key.includes(k)) && activeFilters.entities.has(ev.payload[key])) {
                        hasEntity = true;
                        break;
                    }
                }
            }

            if (!hasEntity) return false;
        }

        // Time Filter
        if (activeFilters.minTime !== null || activeFilters.maxTime !== null) {
            const evTime = parseFloat(ev.time);
            if (!isNaN(evTime)) {
                if (activeFilters.minTime !== null && evTime < activeFilters.minTime) return false;
                if (activeFilters.maxTime !== null && evTime > activeFilters.maxTime) return false;
            }
        }

        // Text Search
        if (compiledRegex) {
            if (!compiledRegex.test(ev.payloadRaw) && !compiledRegex.test(ev.type)) {
                return false;
            }
        } else if (fallbackTextTerm) {
            if (!ev.payloadRaw.toLowerCase().includes(fallbackTextTerm) && !ev.type.toLowerCase().includes(fallbackTextTerm)) {
                return false;
            }
        }

        return true;
    });

    renderTable();
}

function renderTableHeaders() {
    const headerMap = {
        pin: '<th class="col-pin">Pin</th>',
        file: '<th class="col-file">File</th>',
        time: '<th class="col-time">Time</th>',
        timeDelta: '<th class="col-time-delta" title="Mechanic time since previous visible event">Δ Mech</th>',
        realTime: '<th class="col-time" title="Real World Time">Real Time</th>',
        realTimeDelta: '<th class="col-time-delta" title="Real-world time since previous visible event">Δ Real</th>',
        type: '<th class="col-type">Event Type</th>',
        source: '<th class="col-source">Source Name/ID</th>',
        target: '<th class="col-target">Target Name/ID</th>',
        details: '<th class="col-details">Details / Payload</th>'
    };

    customColumns.forEach(c => {
        headerMap[`custom_${c}`] = `<th class="col-dynamic">${c} <button class="btn" style="padding:0px 4px;font-size:0.7rem;background:transparent;border:none;cursor:pointer" onclick="removeCustomCol('${c}')">&times;</button></th>`;
    });

    tableHeaderRow.innerHTML = columnOrder.map(colId => {
        let htmlStr = headerMap[colId];
        if (htmlStr) {
            let widthStyle = '';
            if (tableLayoutLocked && columnWidthsMap[colId]) {
                widthStyle = ` style="width: ${columnWidthsMap[colId]}px; min-width: 30px; max-width: ${columnWidthsMap[colId]}px;"`;
            }
            return htmlStr.replace('<th', `<th data-col-id="${colId}"${widthStyle}`);
        }
        return '';
    }).join('');

    const table = document.querySelector('.event-table');
    if (tableLayoutLocked) {
        table.style.tableLayout = 'fixed';
        table.style.width = '100%';
    }

    initResizableColumns();
    initDraggableColumns();
}

function initDraggableColumns() {
    const cols = Array.from(tableHeaderRow.querySelectorAll('th'));
    let draggedCol = null;
    let currentTargetCol = null;

    cols.forEach(col => {
        col.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target && e.target.classList && e.target.classList.contains('resize-handle')) return;
            if (e.target && e.target.closest && e.target.closest('button')) return;

            e.preventDefault();

            draggedCol = col;
            currentTargetCol = null;
            draggedCol.classList.add('dragging');
            document.body.classList.add('is-dragging');

            document.addEventListener('mousemove', mouseMoveDrag);
            document.addEventListener('mouseup', mouseUpDrag);
        });
    });

    const mouseMoveDrag = function (e) {
        if (!draggedCol) return;

        const targetElement = document.elementFromPoint(e.clientX, e.clientY);
        if (!targetElement) return;

        const th = targetElement.closest('th');

        if (th && th !== draggedCol && cols.includes(th)) {
            if (currentTargetCol !== th) {
                cols.forEach(c => c.classList.remove('drag-over'));
                currentTargetCol = th;
                currentTargetCol.classList.add('drag-over');
            }
        }
        // Deliberately NOT clearing currentTargetCol on empty space hovers 
        // to prevent mouse-wobble from cancelling drops entirely.
    };

    const mouseUpDrag = function () {
        if (!draggedCol) return;

        draggedCol.classList.remove('dragging');
        document.body.classList.remove('is-dragging');
        cols.forEach(c => c.classList.remove('drag-over'));

        if (currentTargetCol && draggedCol !== currentTargetCol) {
            const draggedId = draggedCol.dataset.colId;
            const targetId = currentTargetCol.dataset.colId;

            const fromIdx = columnOrder.indexOf(draggedId);
            const toIdx = columnOrder.indexOf(targetId);

            if (fromIdx > -1 && toIdx > -1) {
                columnOrder.splice(fromIdx, 1);
                columnOrder.splice(toIdx, 0, draggedId);

                // Re-cache widths for the new order before rendering
                if (tableLayoutLocked) {
                    const tableCols = Array.from(tableHeaderRow.querySelectorAll('th'));
                    tableCols.forEach((c) => {
                        const id = c.dataset.colId;
                        if (c.getBoundingClientRect().width > 0) {
                            columnWidthsMap[id] = c.getBoundingClientRect().width;
                        }
                    });
                }

                renderTableHeaders();
                renderVirtualTable();
            }
        }

        draggedCol = null;
        currentTargetCol = null;
        document.removeEventListener('mousemove', mouseMoveDrag);
        document.removeEventListener('mouseup', mouseUpDrag);
    };
}

function initResizableColumns() {
    const cols = tableHeaderRow.querySelectorAll('th');

    cols.forEach((col, index) => {
        // Create handle
        const resizer = document.createElement('div');
        resizer.classList.add('resize-handle');
        col.appendChild(resizer);

        // Variables for drag state
        let x = 0;
        let w = 0;
        let currentHeader = null;

        const mouseDownHandler = function (e) {
            e.stopPropagation();
            currentHeader = col;
            x = e.clientX;

            const table = document.querySelector('.event-table');
            if (!tableLayoutLocked) {
                const headCols = Array.from(tableHeaderRow.querySelectorAll('th'));
                headCols.forEach((c) => {
                    const id = c.dataset.colId;
                    const w = c.getBoundingClientRect().width;
                    columnWidthsMap[id] = w;
                    c.style.width = `${w}px`;
                    c.style.minWidth = `30px`;
                    c.style.maxWidth = `${w}px`;
                });
                tableLayoutLocked = true;
                table.style.tableLayout = 'fixed';
                table.style.width = `100%`;
            }

            const styles = window.getComputedStyle(currentHeader);
            w = parseInt(styles.width, 10);

            resizer.classList.add('active');

            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler);

            e.preventDefault();
        };

        const mouseMoveHandler = function (e) {
            const dx = e.clientX - x;
            const newWidth = Math.max(30, w + dx);
            const colId = currentHeader.dataset.colId;
            columnWidthsMap[colId] = newWidth;

            currentHeader.style.width = `${newWidth}px`;
            currentHeader.style.minWidth = `${newWidth}px`;
            currentHeader.style.maxWidth = `${newWidth}px`;
        };

        const mouseUpHandler = function () {
            resizer.classList.remove('active');
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
        };

        const doubleClickHandler = function (e) {
            e.stopPropagation();
            tableLayoutLocked = false;
            columnWidthsMap = {};

            const table = document.querySelector('.event-table');
            table.style.tableLayout = '';
            table.style.width = 'max-content';

            const headCols = Array.from(tableHeaderRow.querySelectorAll('th'));
            headCols.forEach((c) => {
                c.style.width = '';
                c.style.minWidth = '';
                c.style.maxWidth = '';
            });
        };

        resizer.addEventListener('mousedown', mouseDownHandler);
        resizer.addEventListener('dblclick', doubleClickHandler);
    });
}

window.removeCustomCol = function (colName) {
    customColumns = customColumns.filter(c => c !== colName);
    columnOrder = columnOrder.filter(c => c !== `custom_${colName}`);
    renderTableHeaders();
    renderTable();
}

window.togglePin = function (eventId) {
    if (pinnedEvents.has(eventId)) {
        pinnedEvents.delete(eventId);
    } else {
        pinnedEvents.add(eventId);
    }
    renderVirtualTable(); // Re-render to update pinned area and main rows
}

const ROW_HEIGHT = 42;
const BUFFER_ROWS = 15;

function renderTable() {
    totalCount.textContent = parsedEvents.length;
    showingCount.textContent = filteredEvents.length;

    if (parsedEvents.length > 0) {
        emptyState.classList.add('hidden');
        tableContainer.classList.remove('hidden');
    }

    tableContainer.scrollTop = 0;
    renderVirtualTable();
}

function renderVirtualTable() {
    renderPinnedTable();

    const scrollTop = tableContainer.scrollTop;
    const clientHeight = tableContainer.clientHeight || 800;

    let startIndex = Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS;
    if (startIndex < 0) startIndex = 0;

    let endIndex = Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + BUFFER_ROWS;
    if (endIndex > filteredEvents.length) endIndex = filteredEvents.length;

    const paddingTop = startIndex * ROW_HEIGHT;
    const paddingBottom = (filteredEvents.length - endIndex) * ROW_HEIGHT;

    eventTableBody.innerHTML = '';
    const fragment = document.createDocumentFragment();

    if (paddingTop > 0) {
        const topSpacer = document.createElement('tr');
        topSpacer.innerHTML = `<td colspan="100%" style="height: ${paddingTop}px; padding: 0; border: 0;"></td>`;
        fragment.appendChild(topSpacer);
    }

    let prevTime = null;
    let prevRealTime = null;
    if (startIndex > 0) {
        for (let i = startIndex - 1; i >= 0; i--) {
            const t = parseFloat(filteredEvents[i].time);
            const rt = parseFloat(filteredEvents[i].realTime);
            if (!isNaN(t) && prevTime === null) prevTime = t;
            if (!isNaN(rt) && prevRealTime === null) prevRealTime = rt;
            if (prevTime !== null && prevRealTime !== null) break;
        }
    }

    const toRender = filteredEvents.slice(startIndex, endIndex);

    toRender.forEach(ev => {
        const tr = document.createElement('tr');
        const tdMap = {};

        // Pin
        const tdPin = document.createElement('td');
        tdPin.className = 'col-pin';
        const isPinned = pinnedEvents.has(ev.id);
        tdPin.innerHTML = `<button class="pin-btn ${isPinned ? 'active' : ''}" onclick="togglePin(${ev.id})" title="Pin Event">&#128204;</button>`;
        tdMap['pin'] = tdPin;

        // File
        const tdFile = document.createElement('td');
        tdFile.className = 'col-file';
        tdFile.textContent = ev.file || '-';
        tdFile.title = ev.file || '';
        tdMap['file'] = tdFile;

        // Time
        const tdTime = document.createElement('td');
        tdTime.className = 'col-time';
        tdTime.textContent = ev.time || '-';
        tdMap['time'] = tdTime;

        // Delta Time (Mech)
        const tdDelta = document.createElement('td');
        tdDelta.className = 'col-time-delta';
        const currentTime = parseFloat(ev.time);

        if (prevTime !== null && !isNaN(currentTime)) {
            const delta = (currentTime - prevTime).toFixed(3);
            tdDelta.textContent = `+${delta}s`;
        } else {
            tdDelta.textContent = '-';
        }

        // Real Time
        const tdRealTime = document.createElement('td');
        tdRealTime.className = 'col-time';
        tdRealTime.textContent = ev.realTime || '-';
        tdMap['realTime'] = tdRealTime;

        // Delta Time (Real)
        const tdRealDelta = document.createElement('td');
        tdRealDelta.className = 'col-time-delta';
        const currentRealTime = parseFloat(ev.realTime);

        if (prevRealTime !== null && !isNaN(currentRealTime)) {
            const rDelta = (currentRealTime - prevRealTime).toFixed(3);
            tdRealDelta.textContent = `+${rDelta}s`;
        } else {
            tdRealDelta.textContent = '-';
        }

        if (!isNaN(currentTime)) prevTime = currentTime;
        if (!isNaN(currentRealTime)) prevRealTime = currentRealTime;

        tdMap['timeDelta'] = tdDelta;
        tdMap['realTimeDelta'] = tdRealDelta;

        // Type
        const tdType = document.createElement('td');
        tdType.className = 'col-type';
        const spanBadge = document.createElement('span');
        spanBadge.className = `badge ${getBadgeClass(ev.type)}`;
        spanBadge.textContent = ev.type || 'UNKNOWN';
        tdType.appendChild(spanBadge);
        tdMap['type'] = tdType;

        // Source
        const tdSource = document.createElement('td');
        tdSource.className = 'col-source';
        if (ev.sourceName || ev.sourceId) {
            tdSource.innerHTML = `<strong>${ev.sourceName || 'Unknown'}</strong> <span class="entity-id">${ev.sourceId}</span>`;
        } else {
            tdSource.textContent = '-';
        }
        tdMap['source'] = tdSource;

        // Target
        const tdTarget = document.createElement('td');
        tdTarget.className = 'col-target';
        if (ev.targetName || ev.targetId) {
            tdTarget.innerHTML = `<strong>${ev.targetName || 'Unknown'}</strong> <span class="entity-id">${ev.targetId}</span>`;
        } else {
            tdTarget.textContent = '-';
        }
        tdMap['target'] = tdTarget;

        // Custom Columns
        customColumns.forEach(c => {
            const td = document.createElement('td');
            td.className = 'col-dynamic';
            td.textContent = ev.payload[c] !== undefined ? ev.payload[c] : '-';
            tdMap[`custom_${c}`] = td;
        });

        // Details
        const tdDetails = document.createElement('td');
        tdDetails.className = 'col-details';

        if (ev.isMultiline) {
            tdDetails.innerHTML = `<span class="table-payload-preview">Lua Table Data</span>
                                  <button class="payload-btn" onclick="showPayloadModal(${ev.id})">View JSON</button>`;
        } else {
            let previewText = Object.entries(ev.payload)
                .filter(([k, v]) => !k.includes('Name') && !k.includes('Entity ID') && !k.includes('Caster ID') && !k.includes('Target ID') && !customColumns.includes(k))
                .map(([k, v]) => `<span style="color:var(--text-tertiary)">${k}:</span> ${v}`)
                .join(' | ');

            if (!previewText && !Object.keys(ev.payload).length) previewText = ev.payloadRaw;

            tdDetails.innerHTML = `<div class="table-payload-preview" title="Click to view full event JSON" onclick="showPayloadModal(${ev.id})">${previewText}</div>`;
        }
        tdMap['details'] = tdDetails;

        columnOrder.forEach(colId => {
            if (tdMap[colId]) tr.appendChild(tdMap[colId]);
        });

        fragment.appendChild(tr);
    });

    if (paddingBottom > 0) {
        const bottomSpacer = document.createElement('tr');
        bottomSpacer.innerHTML = `<td colspan="100%" style="height: ${paddingBottom}px; padding: 0; border: 0;"></td>`;
        fragment.appendChild(bottomSpacer);
    }

    eventTableBody.appendChild(fragment);

    // Call initResizableColumns on initial load if empty state clears
    if (parsedEvents.length > 0 && !tableHeaderRow.querySelector('.resize-handle')) {
        initResizableColumns();
    }
}

function renderPinnedTable() {
    const pinnedBody = document.getElementById('pinnedTableBody');
    if (!pinnedBody) return;

    pinnedBody.innerHTML = '';

    if (pinnedEvents.size === 0) return;

    const fragment = document.createDocumentFragment();

    const pEvents = Array.from(pinnedEvents).map(id => parsedEvents[id]).filter(Boolean);

    // Sort pinned events by time so they remain chronological
    pEvents.sort((a, b) => parseFloat(a.time) - parseFloat(b.time));

    const headerHeight = tableHeaderRow.offsetHeight || 42;

    pEvents.forEach((ev, index) => {
        const tr = document.createElement('tr');
        tr.className = 'pinned-row';
        const topOffset = headerHeight + (index * ROW_HEIGHT);
        const tdMap = {};

        // Pin
        const tdPin = document.createElement('td');
        tdPin.className = 'col-pin';
        tdPin.innerHTML = `<button class="pin-btn active" onclick="togglePin(${ev.id})" title="Unpin Event">&#128204;</button>`;
        tdMap['pin'] = tdPin;

        // File
        const tdFile = document.createElement('td');
        tdFile.className = 'col-file';
        tdFile.textContent = ev.file || '-';
        tdFile.title = ev.file || '';
        tdMap['file'] = tdFile;

        // Time
        const tdTime = document.createElement('td');
        tdTime.className = 'col-time';
        tdTime.textContent = ev.time || '-';
        tdMap['time'] = tdTime;

        // Delta Time (Pinned doesn't calculate dynamic delta to avoid confusion, keep it locked at -)
        const tdDelta = document.createElement('td');
        tdDelta.className = 'col-time-delta';
        tdDelta.textContent = '-';
        tdMap['timeDelta'] = tdDelta;

        // Real Time
        const tdRealTime = document.createElement('td');
        tdRealTime.className = 'col-time';
        tdRealTime.textContent = ev.realTime || '-';
        tdMap['realTime'] = tdRealTime;

        // Real Time Delta
        const tdRealDelta = document.createElement('td');
        tdRealDelta.className = 'col-time-delta';
        tdRealDelta.textContent = '-';
        tdMap['realTimeDelta'] = tdRealDelta;

        // Type
        const tdType = document.createElement('td');
        tdType.className = 'col-type';
        const spanBadge = document.createElement('span');
        spanBadge.className = `badge ${getBadgeClass(ev.type)}`;
        spanBadge.textContent = ev.type || 'UNKNOWN';
        tdType.appendChild(spanBadge);
        tdMap['type'] = tdType;

        // Source
        const tdSource = document.createElement('td');
        tdSource.className = 'col-source';
        if (ev.sourceName || ev.sourceId) {
            tdSource.innerHTML = `<strong>${ev.sourceName || 'Unknown'}</strong> <span class="entity-id">${ev.sourceId}</span>`;
        } else {
            tdSource.textContent = '-';
        }
        tdMap['source'] = tdSource;

        // Target
        const tdTarget = document.createElement('td');
        tdTarget.className = 'col-target';
        if (ev.targetName || ev.targetId) {
            tdTarget.innerHTML = `<strong>${ev.targetName || 'Unknown'}</strong> <span class="entity-id">${ev.targetId}</span>`;
        } else {
            tdTarget.textContent = '-';
        }
        tdMap['target'] = tdTarget;

        // Custom Columns
        customColumns.forEach(c => {
            const td = document.createElement('td');
            td.className = 'col-dynamic';
            td.textContent = ev.payload[c] !== undefined ? ev.payload[c] : '-';
            tdMap[`custom_${c}`] = td;
        });

        // Details
        const tdDetails = document.createElement('td');
        tdDetails.className = 'col-details';

        if (ev.isMultiline) {
            tdDetails.innerHTML = `<span class="table-payload-preview">Lua Table Data</span>
                                  <button class="payload-btn" onclick="showPayloadModal(${ev.id})">View JSON</button>`;
        } else {
            let previewText = Object.entries(ev.payload)
                .filter(([k, v]) => !k.includes('Name') && !k.includes('Entity ID') && !k.includes('Caster ID') && !k.includes('Target ID') && !customColumns.includes(k))
                .map(([k, v]) => `<span style="color:var(--text-tertiary)">${k}:</span> ${v}`)
                .join(' | ');

            if (!previewText && !Object.keys(ev.payload).length) previewText = ev.payloadRaw;

            tdDetails.innerHTML = `<div class="table-payload-preview" title="Click to view full event JSON" onclick="showPayloadModal(${ev.id})">${previewText}</div>`;
        }
        tdMap['details'] = tdDetails;

        columnOrder.forEach(colId => {
            if (tdMap[colId]) {
                const td = tdMap[colId];
                td.style.position = 'sticky';
                td.style.top = `${topOffset}px`;
                td.style.zIndex = '9';
                tr.appendChild(td);
            }
        });

        fragment.appendChild(tr);
    });

    pinnedBody.appendChild(fragment);
}

function getBadgeClass(type) {
    const t = type.toLowerCase();
    if (t.includes('visibility')) return 'badge-visibility';
    if (t.includes('transform')) return 'badge-transform';
    if (t.includes('animation')) return 'badge-animation';
    if (t.includes('casttarget')) return 'badge-casttarget';
    if (t.includes('cast')) return 'badge-cast';
    if (t.includes('aura')) return 'badge-aura';
    return 'badge-default';
}

// Global modal trigger
window.showPayloadModal = function (eventId) {
    const ev = parsedEvents.find(e => e.id === eventId);
    if (!ev) return;

    const modTitle = document.getElementById('modalTitle');
    const modPayload = document.getElementById('modalCodePayload');

    if (ev.isMultiline) {
        modTitle.textContent = `Event ID: ${ev.id} - ${ev.type} (Lua Table)`;
        modPayload.textContent = ev.payloadRaw;
    } else {
        modTitle.textContent = `Event ID: ${ev.id} - ${ev.type} (JSON Payload)`;
        modPayload.textContent = "RAW SOURCE:\n" + ev.payloadRaw + "\n\nPARSED DATA:\n" + JSON.stringify(ev.payload, null, 2);
    }

    dataModal.classList.remove('hidden');
}

// Utility
function showLoader(show) {
    if (show) loader.classList.remove('hidden');
    else loader.classList.add('hidden');
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Data Export Functions
function exportToCsv() {
    if (filteredEvents.length === 0) return alert("No events to export.");

    // Headers
    let headers = ['Time', 'Event Type', 'Source Name', 'Source ID', 'Target Name', 'Target ID', ...customColumns, 'Raw Payload'];
    let csvRows = [headers.join(',')];

    filteredEvents.forEach(ev => {
        const row = [
            ev.time,
            ev.type,
            ev.sourceName,
            ev.sourceId,
            ev.targetName,
            ev.targetId,
            ...customColumns.map(c => ev.payload[c] ? `"${ev.payload[c].replace(/"/g, '""')}"` : ''),
            `"${ev.payloadRaw.replace(/"/g, '""')}"` // Escape quotes
        ];
        csvRows.push(row.join(','));
    });

    const csvData = csvRows.join('\n');
    downloadFile(csvData, 'exported_logs.csv', 'text/csv');
}

function exportToJson() {
    if (filteredEvents.length === 0) return alert("No events to export.");
    const jsonData = JSON.stringify(filteredEvents, null, 2);
    downloadFile(jsonData, 'exported_logs.json', 'application/json');
}

function downloadFile(content, fileName, contentType) {
    const a = document.createElement("a");
    const file = new Blob([content], { type: contentType });
    a.href = URL.createObjectURL(file);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
}

// Global UI actions
window.toggleAllCheckboxes = function (containerId, filterSet, selectAll) {
    const container = document.getElementById(containerId);
    const checkboxes = container.querySelectorAll('.select-item input[type="checkbox"]');

    checkboxes.forEach(cb => {
        if (cb.closest('.select-item').style.display !== 'none') {
            cb.checked = selectAll;
            if (selectAll) {
                filterSet.add(cb.value);
            } else {
                filterSet.delete(cb.value);
            }
        }
    });

    updateSelectText();
    applyFiltersAndRender();
};

// --- Timeline Visualizer ---
const timelineContainer = document.getElementById('timelineContainer');
const timelineCanvas = document.getElementById('timelineCanvas');
const timelineBrush = document.getElementById('timelineBrush');
const brushHandleLeft = document.getElementById('brushHandleLeft');
const brushHandleRight = document.getElementById('brushHandleRight');

let timelineCtx = timelineCanvas.getContext('2d');
let timelineIsDragging = false;
let timelineDragStartX = 0;
let timelineCurrentLeftPct = 0;
let timelineCurrentRightPct = 100;
let timelineDragHandle = null; // 'left', 'right', 'center', 'new'
let timelineGlobalMinTime = 0;
let timelineGlobalMaxTime = 0;
let timelineDragStartLeft = 0;
let timelineDragStartRight = 0;

function renderTimeline() {
    if (!parsedEvents || parsedEvents.length === 0) {
        timelineContainer.style.display = 'none';
        return;
    }

    timelineContainer.style.display = 'block';

    const rect = timelineContainer.getBoundingClientRect();
    timelineCanvas.width = rect.width;
    timelineCanvas.height = 40;

    // Find global min and max
    timelineGlobalMinTime = parseFloat(parsedEvents[0].time) || 0;
    timelineGlobalMaxTime = parseFloat(parsedEvents[parsedEvents.length - 1].time) || 0;

    let timeSpan = timelineGlobalMaxTime - timelineGlobalMinTime;
    if (timeSpan <= 0) timeSpan = 1;

    // Bucketize events
    const bucketCount = Math.max(1, Math.floor(timelineCanvas.width / 2)); // 2px per bucket
    const buckets = new Array(bucketCount).fill(0);
    let maxBucketVal = 0;

    for (let i = 0; i < parsedEvents.length; i++) {
        let t = parseFloat(parsedEvents[i].time) || timelineGlobalMinTime;
        let pct = (t - timelineGlobalMinTime) / timeSpan;
        let bIdx = Math.floor(pct * (bucketCount - 1));
        if (bIdx >= 0 && bIdx < bucketCount) {
            buckets[bIdx]++;
            if (buckets[bIdx] > maxBucketVal) maxBucketVal = buckets[bIdx];
        }
    }

    timelineCtx.clearRect(0, 0, timelineCanvas.width, timelineCanvas.height);

    // Draw sparkline
    timelineCtx.fillStyle = 'rgba(99, 102, 241, 0.4)';
    timelineCtx.beginPath();
    timelineCtx.moveTo(0, timelineCanvas.height);

    for (let i = 0; i < bucketCount; i++) {
        let x = (i / bucketCount) * timelineCanvas.width;
        let normalizedHeight = maxBucketVal > 0 ? (buckets[i] / maxBucketVal) * (timelineCanvas.height - 4) : 0;
        let y = timelineCanvas.height - normalizedHeight;
        timelineCtx.lineTo(x, y);
        timelineCtx.lineTo(x + 2, y);
    }

    timelineCtx.lineTo(timelineCanvas.width, timelineCanvas.height);
    timelineCtx.closePath();
    timelineCtx.fill();

    updateBrushOverlayCSS();
}

function updateBrushOverlayCSS() {
    timelineBrush.style.display = 'block';
    timelineBrush.style.left = `${timelineCurrentLeftPct}%`;
    timelineBrush.style.width = `${timelineCurrentRightPct - timelineCurrentLeftPct}%`;

    // Sync to numerical inputs but DO NOT trigger filters recursively
    let timeSpan = timelineGlobalMaxTime - timelineGlobalMinTime;
    minTimeInput.value = (timelineGlobalMinTime + (timelineCurrentLeftPct / 100) * timeSpan).toFixed(1);
    maxTimeInput.value = (timelineGlobalMinTime + (timelineCurrentRightPct / 100) * timeSpan).toFixed(1);
}

timelineContainer.addEventListener('mousedown', (e) => {
    const rect = timelineCanvas.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let pctClick = (x / rect.width) * 100;

    if (e.target === brushHandleLeft) {
        timelineDragHandle = 'left';
    } else if (e.target === brushHandleRight) {
        timelineDragHandle = 'right';
    } else if (e.target === timelineBrush || (timelineCurrentRightPct > timelineCurrentLeftPct && pctClick >= timelineCurrentLeftPct && pctClick <= timelineCurrentRightPct)) {
        timelineDragHandle = 'center';
    } else {
        timelineDragHandle = 'new';
        timelineCurrentLeftPct = Math.max(0, Math.min(100, pctClick));
        timelineCurrentRightPct = timelineCurrentLeftPct;
    }

    timelineIsDragging = true;
    timelineDragStartX = e.clientX;
    timelineDragStartLeft = timelineCurrentLeftPct;
    timelineDragStartRight = timelineCurrentRightPct;

    document.body.style.cursor = timelineDragHandle === 'center' ? 'grabbing' : 'ew-resize';
    document.addEventListener('mousemove', timelineMouseMove);
    document.addEventListener('mouseup', timelineMouseUp);
});

function timelineMouseMove(e) {
    if (!timelineIsDragging) return;

    const rect = timelineCanvas.getBoundingClientRect();
    let dx = e.clientX - timelineDragStartX;
    let dPct = (dx / rect.width) * 100;

    if (timelineDragHandle === 'left') {
        timelineCurrentLeftPct = Math.min(timelineDragStartRight - 1, Math.max(0, timelineDragStartLeft + dPct));
    } else if (timelineDragHandle === 'right') {
        timelineCurrentRightPct = Math.max(timelineDragStartLeft + 1, Math.min(100, timelineDragStartRight + dPct));
    } else if (timelineDragHandle === 'center') {
        let width = timelineDragStartRight - timelineDragStartLeft;
        let newLeft = timelineDragStartLeft + dPct;
        if (newLeft < 0) newLeft = 0;
        if (newLeft + width > 100) newLeft = 100 - width;
        timelineCurrentLeftPct = newLeft;
        timelineCurrentRightPct = newLeft + width;
    } else if (timelineDragHandle === 'new') {
        let pctHover = Math.max(0, Math.min(100, timelineDragStartLeft + dPct));
        if (pctHover < timelineDragStartLeft) {
            timelineCurrentLeftPct = pctHover;
            timelineCurrentRightPct = timelineDragStartLeft;
        } else {
            timelineCurrentLeftPct = timelineDragStartLeft;
            timelineCurrentRightPct = pctHover;
        }
    }

    updateBrushOverlayCSS();
}

function timelineMouseUp(e) {
    if (!timelineIsDragging) return;
    timelineIsDragging = false;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', timelineMouseMove);
    document.removeEventListener('mouseup', timelineMouseUp);

    // Sync active filters manually since programmatic value changes don't fire native input events
    activeFilters.minTime = minTimeInput.value === '' ? null : parseFloat(minTimeInput.value);
    activeFilters.maxTime = maxTimeInput.value === '' ? null : parseFloat(maxTimeInput.value);

    // Apply filters based on new bracket
    applyFiltersAndRender();
}

window.addEventListener('resize', () => {
    if (parsedEvents && parsedEvents.length > 0) renderTimeline();
});

// Boot
init();
