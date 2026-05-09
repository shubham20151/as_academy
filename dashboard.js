// --- Cursor Glow ---
const cursorGlow = document.getElementById('cursorGlow');
document.addEventListener('mousemove', e => {
    cursorGlow.style.left = e.clientX + 'px';
    cursorGlow.style.top = e.clientY + 'px';
});

// --- Firebase Config ---
const firebaseConfig = {
    apiKey: "AIzaSyCG5EZoyctsQCoSrlbXyQ1Q4qQ5bVEkMis",
    authDomain: "asacademywpbot.firebaseapp.com",
    databaseURL: "https://asacademywpbot-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "asacademywpbot",
    storageBucket: "asacademywpbot.firebasestorage.app",
    messagingSenderId: "250186915176",
    appId: "1:250186915176:web:885a1cea554752171b0add"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

// --- Shorthand ---
const $ = id => document.getElementById(id);

// --- Navigation ---
const navItems = document.querySelectorAll('.nav-item[data-target]');
const sections = document.querySelectorAll('.section');
navItems.forEach(item => {
    item.addEventListener('click', () => {
        navItems.forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        sections.forEach(s => s.classList.remove('active'));
        $(item.dataset.target).classList.add('active');
        $('topbarTitle').textContent = item.querySelector('span').textContent;
        if (window.innerWidth < 900) {
            $('sidebar').classList.remove('open');
            $('sidebarOverlay').classList.remove('show');
        }
    });
});

$('menuToggle').onclick = (e) => {
    e.stopPropagation();
    const isOpen = $('sidebar').classList.toggle('open');
    $('sidebarOverlay').classList.toggle('show', isOpen);
};

$('sidebarOverlay').onclick = () => {
    $('sidebar').classList.remove('open');
    $('sidebarOverlay').classList.remove('show');
};

document.addEventListener('click', (e) => {
    const sidebar = $('sidebar');
    if (window.innerWidth < 900 && sidebar.classList.contains('open')) {
        if (!sidebar.contains(e.target) && e.target !== $('menuToggle')) {
            sidebar.classList.remove('open');
            $('sidebarOverlay').classList.remove('show');
        }
    }
});
// --- Auth ---
$('authOverlay').style.display = 'flex';

$('loginBtn').onclick = () => {
    const u = $('adminEmail').value.trim();
    const p = $('adminPassword').value.trim();
    if (u === 'ASEQP' && p === 'ASEQP') {
        auth.signInAnonymously().catch(() => {});
        $('authOverlay').style.display = 'none';
        initData();
    } else {
        $('authError').textContent = '❌ Invalid credentials.';
        setTimeout(() => $('authError').textContent = '', 3000);
    }
};

$('adminPassword').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

$('logoutBtn').onclick = () => {
    auth.signOut();
    $('authOverlay').style.display = 'flex';
    $('adminEmail').value = '';
    $('adminPassword').value = '';
};

// --- Firebase REST URL ---
const FIREBASE_REST = 'https://asacademywpbot-default-rtdb.asia-southeast1.firebasedatabase.app';

// --- Spin animation for refresh buttons ---
(function injectSpinStyle() {
    const s = document.createElement('style');
    s.textContent = `
        @keyframes spin-once { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spinning { animation: spin-once 0.6s cubic-bezier(0.4,0,0.2,1); }
    `;
    document.head.appendChild(s);
})();

function spinRefresh(iconId, fn) {
    const icon = document.getElementById(iconId);
    if (icon) {
        icon.classList.remove('spinning');
        void icon.offsetWidth; // force reflow to restart animation
        icon.classList.add('spinning');
        setTimeout(() => icon.classList.remove('spinning'), 650);
    }
    fn();
}

window.refreshLeads     = () => spinRefresh('refreshLeadsIcon',     loadLeads);
window.refreshSuggested = () => spinRefresh('refreshSuggestedIcon', loadSuggested);

// --- Data Loading ---
function initData() { loadCourses(); loadLeads(); loadSuggested(); }

function formatTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
}

let coursesData = [];
let leadsData = [];
let suggestedData = [];
let currentCoursesPage = 1;
let currentLeadsPage = 1;
let currentSuggestedPage = 1;
const itemsPerPage = 10;
const coursesPerPage = 8; // Slightly fewer for the grid

window.changeCoursesPage = (page) => { currentCoursesPage = page; renderCoursesGrid(); };

function renderCoursesGrid() {
    const grid = $('coursesGrid');
    grid.innerHTML = '';
    
    const startIdx = (currentCoursesPage - 1) * coursesPerPage;
    const paginatedCourses = coursesData.slice(startIdx, startIdx + coursesPerPage);
    
    let htmlStr = '';
    paginatedCourses.forEach(item => {
        const imgHtml = item.imageUrl
            ? `<img src="${item.imageUrl}" alt="${item.name}" loading="lazy">`
            : `<div style="height:150px;background:linear-gradient(135deg,rgba(59,130,246,0.1),rgba(6,182,212,0.05));display:flex;align-items:center;justify-content:center;font-size:2.5rem;border-bottom:1px solid rgba(255,255,255,0.06)">📚</div>`;
        const safeName = item.name.replace(/`/g, '\\`').replace(/'/g, "\\'");
        htmlStr += `
        <div class="course-card">
            ${imgHtml}
            <div class="card-actions">
                <button class="action-btn edit" onclick="editCourse('${item.id}','${safeName}','${item.imageUrl||''}','${item.link||''}')"><i class="fas fa-pen"></i></button>
                <button class="action-btn delete" onclick="deleteItem('courses','${item.id}')"><i class="fas fa-trash"></i></button>
            </div>
            <div class="course-card-body"><h4>${item.name}</h4></div>
        </div>`;
    });
    grid.innerHTML = htmlStr;
    
    if (!coursesData.length) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:40px">No courses yet. Click "Add Course" to create one!</div>';
    }
    
    // Override itemsPerPage temporarily for the generic pagination function
    renderPagination(coursesData.length, currentCoursesPage, 'coursesPagination', 'changeCoursesPage', coursesPerPage);
}

function loadCourses() {
    fetch(FIREBASE_REST + '/courses.json?t=' + Date.now())
        .then(r => r.json())
        .then(d => {
            coursesData = [];
            if (d && typeof d === 'object') {
                for (const [key, val] of Object.entries(d)) {
                    if (val && typeof val === 'object') coursesData.push({ id: key, ...val });
                }
            }
            $('stat-courses').textContent = coursesData.length;
            const maxPage = Math.ceil(coursesData.length / coursesPerPage) || 1;
            if (currentCoursesPage > maxPage) currentCoursesPage = maxPage;
            renderCoursesGrid();
        })
        .catch(e => console.error('Failed to load courses:', e));
}

function renderPagination(totalItems, currentPage, containerId, onPageChange, perPage = itemsPerPage) {
    const totalPages = Math.ceil(totalItems / perPage) || 1;
    const container = $(containerId);
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }
    
    let html = `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} onclick="${onPageChange}(${currentPage - 1})"><i class="fas fa-chevron-left"></i></button>`;
    html += `<span class="pagination-info">Page ${currentPage} of ${totalPages}</span>`;
    html += `<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} onclick="${onPageChange}(${currentPage + 1})"><i class="fas fa-chevron-right"></i></button>`;
    
    container.innerHTML = html;
}

window.changeLeadsPage = (page) => { currentLeadsPage = page; renderLeadsTable(); };
window.changeSuggestedPage = (page) => { currentSuggestedPage = page; renderSuggestedTable(); };

function renderLeadsTable() {
    console.log('Rendering Leads Table. Total Leads:', leadsData.length);
    const tbody = $('leadsTableBody');
    tbody.innerHTML = '';
    
    const startIdx = (currentLeadsPage - 1) * itemsPerPage;
    const paginatedLeads = leadsData.slice(startIdx, startIdx + itemsPerPage);
    
    let htmlStr = '';
    paginatedLeads.forEach(lead => {
        const displayDate = lead.date || (lead.timestamp ? new Date(lead.timestamp).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—');
        const displayTime = lead.time || (lead.timestamp ? new Date(lead.timestamp).toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit',hour12:true}) : '—');
        htmlStr += `
        <tr>
            <td style="color:var(--muted);font-size:0.82rem">${displayDate}</td>
            <td style="color:var(--muted);font-size:0.82rem">${displayTime}</td>
            <td style="font-weight:700">${lead.name || '—'}</td>
            <td style="font-family:monospace;color:var(--cyan)">${lead.phone || '—'}</td>
            <td><span class="badge badge-blue">${lead.course || '—'}</span></td>
            <td><button onclick="deleteItem('leads','${lead.id}')" style="background:none;border:none;cursor:pointer;color:#ef4444;font-size:1rem;padding:4px 8px;border-radius:6px;transition:background 0.2s" title="Delete"><i class="fas fa-trash"></i></button></td>
        </tr>`;
    });
    tbody.innerHTML = htmlStr;
    
    if (!leadsData.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:40px">No leads yet</td></tr>';
    }
    renderPagination(leadsData.length, currentLeadsPage, 'leadsPagination', 'changeLeadsPage');
}

function renderSuggestedTable() {
    const tbody = $('suggestedTableBody');
    tbody.innerHTML = '';
    
    const startIdx = (currentSuggestedPage - 1) * itemsPerPage;
    const paginatedList = suggestedData.slice(startIdx, startIdx + itemsPerPage);
    
    let htmlStr = '';
    paginatedList.forEach(item => {
        htmlStr += `
        <tr>
            <td style="color:var(--muted);font-size:0.82rem">${formatTime(item.timestamp)}</td>
            <td style="font-weight:700">${item.name || '—'}</td>
            <td style="font-family:monospace;color:var(--cyan)">${item.phone || '—'}</td>
            <td><span class="badge badge-orange">${item.suggestion || '—'}</span></td>
            <td><button onclick="deleteItem('suggested','${item.id}')" style="background:none;border:none;cursor:pointer;color:#ef4444;font-size:1rem;padding:4px 8px;border-radius:6px;transition:background 0.2s" title="Delete"><i class="fas fa-trash"></i></button></td>
        </tr>`;
    });
    tbody.innerHTML = htmlStr;
    
    if (!suggestedData.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:40px">No suggestions yet</td></tr>';
    }
    renderPagination(suggestedData.length, currentSuggestedPage, 'suggestedPagination', 'changeSuggestedPage');
}

function loadLeads() {
    console.log('Fetching leads via REST...');
    fetch(FIREBASE_REST + '/leads.json?t=' + Date.now())
        .then(r => r.json())
        .then(d => {
            leadsData = [];
            if (d && typeof d === 'object') {
                for (const [key, val] of Object.entries(d)) {
                    if (val && typeof val === 'object') leadsData.push({ id: key, ...val });
                }
            }
            console.log('Fetched leads via REST:', leadsData);
            leadsData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            // Update recent leads (Overview tab)
            const recTbody = $('recentLeadsBody');
            let recHtml = '';
            leadsData.slice(0, 5).forEach(lead => {
                const displayDate = lead.date || (lead.timestamp ? new Date(lead.timestamp).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : '—');
                const displayTime = lead.time || (lead.timestamp ? new Date(lead.timestamp).toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit',hour12:true}) : '—');
                recHtml += `
                <tr>
                    <td style="color:var(--muted);font-size:0.82rem">${displayDate}</td>
                    <td style="color:var(--muted);font-size:0.82rem">${displayTime}</td>
                    <td style="font-weight:700">${lead.name || '—'}</td>
                    <td style="font-family:monospace;color:var(--cyan)">${lead.phone || '—'}</td>
                    <td><span class="badge badge-blue">${lead.course || '—'}</span></td>
                </tr>`;
            });
            recTbody.innerHTML = recHtml || '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:40px">No leads yet</td></tr>';

            $('stat-leads').textContent = leadsData.length;
            const maxPage = Math.ceil(leadsData.length / itemsPerPage) || 1;
            if (currentLeadsPage > maxPage) currentLeadsPage = maxPage;
            renderLeadsTable();
        })
        .catch(e => console.error('Failed to load leads:', e));
}

function loadSuggested() {
    fetch(FIREBASE_REST + '/suggested.json?t=' + Date.now())
        .then(r => r.json())
        .then(d => {
            suggestedData = [];
            if (d && typeof d === 'object') {
                for (const [key, val] of Object.entries(d)) {
                    if (val && typeof val === 'object') suggestedData.push({ id: key, ...val });
                }
            }
            suggestedData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            $('stat-suggested').textContent = suggestedData.length;
            const maxPage = Math.ceil(suggestedData.length / itemsPerPage) || 1;
            if (currentSuggestedPage > maxPage) currentSuggestedPage = maxPage;
            renderSuggestedTable();
        })
        .catch(e => console.error('Failed to load suggested:', e));
}

// --- Clear & Delete ---
window.clearLeads = () => {
    if (confirm('Clear ALL leads permanently?')) {
        fetch(FIREBASE_REST + '/leads.json', { method: 'DELETE' })
            .then(() => loadLeads())
            .catch(e => console.error(e));
    }
};
window.clearSuggested = () => {
    if (confirm('Clear ALL suggestions permanently?')) {
        fetch(FIREBASE_REST + '/suggested.json', { method: 'DELETE' })
            .then(() => loadSuggested())
            .catch(e => console.error(e));
    }
};
window.deleteItem = (path, id) => {
    if (confirm('Delete this record?')) {
        fetch(FIREBASE_REST + '/' + path + '/' + id + '.json', { method: 'DELETE' })
            .then(() => {
                if (path === 'leads') loadLeads();
                else if (path === 'courses') loadCourses(); // BUG FIX: was calling loadSuggested()
                else loadSuggested();
            })
            .catch(e => console.error(e));
    }
};

// --- Course Modal ---
const courseModal = $('courseModal');
$('openCourseModal').onclick = () => {
    $('courseId').value = '';
    $('courseName').value = '';
    $('courseImageUrl').value = '';
    $('courseLink').value = '';
    $('courseModalTitle').textContent = 'New Course';
    courseModal.style.display = 'flex';
};

document.querySelectorAll('.close-modal').forEach(btn => {
    btn.onclick = () => courseModal.style.display = 'none';
});
courseModal.addEventListener('click', e => { if (e.target === courseModal) courseModal.style.display = 'none'; });

window.editCourse = (id, name, imageUrl, link) => {
    $('courseId').value = id;
    $('courseName').value = name;
    $('courseImageUrl').value = imageUrl !== 'undefined' ? imageUrl : '';
    $('courseLink').value = link !== 'undefined' ? link : '';
    $('courseModalTitle').textContent = 'Edit Course';
    courseModal.style.display = 'flex';
};

$('saveCourseBtn').onclick = () => {
    const id = $('courseId').value;
    const name = $('courseName').value.trim();
    const imageUrl = $('courseImageUrl').value.trim();
    const link = $('courseLink').value.trim();
    if (!name) return;
    const data = { name };
    if (imageUrl) data.imageUrl = imageUrl;
    if (link) data.link = link;
    // BUG FIX: Disable button to prevent double-clicks creating duplicate courses
    const btn = $('saveCourseBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    const op = id ? db.ref(`courses/${id}`).update(data) : db.ref('courses').push(data);
    op.then(() => {
        courseModal.style.display = 'none';
        loadCourses();
    }).catch(e => console.error('Save course error:', e))
      .finally(() => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save"></i> Save Course';
    });
};
