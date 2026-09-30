const DATABASE_NAME = 'morrow-audio-library';
const DATABASE_VERSION = 1;
const STORE_NAME = 'tracks';
const ARCHIVE_ITEM = 'OpenGoldbergVariations';
const ARCHIVE_METADATA_URL = `https://archive.org/metadata/${ARCHIVE_ITEM}`;
const ARCHIVE_DOWNLOAD_URL = `https://archive.org/download/${ARCHIVE_ITEM}`;
const STARTER_TRACK_LIMIT = 25;
const STORAGE_KEYS = { liked: 'morrow-liked-v1', playlists: 'morrow-playlists-v1', queue: 'morrow-queue-v1', volume: 'morrow-volume-v1' };
const COVER_ART = [
    'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=500&q=80',
    'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=500&q=80',
    'https://images.unsplash.com/photo-1490730141103-6cac27aaab94?auto=format&fit=crop&w=500&q=80',
    'https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=500&q=80',
    'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=500&q=80'
];

function readStorage(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        showToast('Browser storage is unavailable.');
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

const ui = {
    audio: document.querySelector('#audio-player'),
    grid: document.querySelector('#track-grid'),
    search: document.querySelector('#search-input'),
    sectionTitle: document.querySelector('#section-title'),
    sectionKicker: document.querySelector('#section-kicker'),
    count: document.querySelector('#results-count'),
    hero: document.querySelector('#hero'),
    cover: document.querySelector('#player-cover'),
    title: document.querySelector('#player-title'),
    artist: document.querySelector('#player-artist'),
    play: document.querySelector('#play-button'),
    progress: document.querySelector('#progress-slider'),
    elapsed: document.querySelector('#elapsed-time'),
    duration: document.querySelector('#duration-time'),
    likedCount: document.querySelector('#liked-count'),
    playlistList: document.querySelector('#playlist-list'),
    queueList: document.querySelector('#queue-list'),
    queueCount: document.querySelector('#queue-count'),
    nowPlaying: document.querySelector('#rail-current'),
    toast: document.querySelector('#toast'),
    playlistDialog: document.querySelector('#playlist-dialog'),
    pickerDialog: document.querySelector('#picker-dialog'),
    playlistName: document.querySelector('#playlist-name'),
    pickerList: document.querySelector('#picker-list'),
    fileInput: document.querySelector('#audio-files')
};

const tracksById = new Map();
let likedIds = readStorage(STORAGE_KEYS.liked, []);
let playlists = readStorage(STORAGE_KEYS.playlists, []);
let queuedIds = readStorage(STORAGE_KEYS.queue, []);
let currentResults = [];
let currentTrack = null;
let currentView = { page: 'home', playlistId: null };
let viewHistory = [];
let forwardHistory = [];
let pendingPlaylistTrackId = null;
let toastTimer;
let shuffleEnabled = false;
let activeFilter = 'all';
let databasePromise;

likedIds = Array.isArray(likedIds) ? likedIds.map(String) : [];
playlists = Array.isArray(playlists) ? playlists.filter((item) => item && item.id && item.name).map((item) => ({
    id: String(item.id), name: String(item.name), trackIds: Array.isArray(item.trackIds) ? item.trackIds.map(String) : []
})) : [];
queuedIds = Array.isArray(queuedIds) ? queuedIds.map(String) : [];

function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return databasePromise;
}

function getAllStoredTracks() {
    return openDatabase().then((database) => new Promise((resolve, reject) => {
        const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }));
}

function storeTracks(records) {
    return openDatabase().then((database) => new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        records.forEach((record) => transaction.objectStore(STORE_NAME).put(record));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Could not save audio files'));
    }));
}

function removeStoredTrack(id) {
    return openDatabase().then((database) => new Promise((resolve, reject) => {
        const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    }));
}

function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => ui.toast.classList.remove('is-visible'), 2800);
}

function getTrack(id) {
    return id == null ? null : tracksById.get(String(id)) || null;
}

function saveCollections() {
    writeStorage(STORAGE_KEYS.liked, likedIds);
    writeStorage(STORAGE_KEYS.playlists, playlists);
    writeStorage(STORAGE_KEYS.queue, queuedIds);
}

function renderTrackGrid(tracks, emptyMessage = 'Your library is ready for its first track.') {
    const usableTracks = tracks.filter((track) => track?.url);
    ui.count.textContent = `${usableTracks.length} ${usableTracks.length === 1 ? 'track' : 'tracks'}`;
    if (!usableTracks.length) {
        ui.grid.innerHTML = `<div class="empty-state"><span>${escapeHtml(emptyMessage)}</span><button class="empty-import" type="button" data-action="import">Add music</button></div>`;
        return;
    }
    ui.grid.innerHTML = usableTracks.map((track, index) => {
        const id = String(track.id);
        const liked = likedIds.includes(id);
        const title = escapeHtml(track.title);
        const artist = escapeHtml(track.artist);
        const artwork = escapeHtml(track.artwork);
        return `<article class="track-card" data-track-id="${escapeHtml(id)}" style="animation-delay:${Math.min(index, 12) * 35}ms">
            <div class="track-art-wrap"><img class="track-art" src="${artwork}" alt="Artwork for ${title}" loading="lazy"><div class="track-actions">
                <button class="card-action${liked ? ' is-liked' : ''}" type="button" data-action="like" aria-label="${liked ? 'Remove like from' : 'Like'} ${title}" title="${liked ? 'Unlike' : 'Like'}"><svg><use href="#i-heart"/></svg></button>
                <button class="card-action" type="button" data-action="playlist" aria-label="Add ${title} to a playlist" title="Add to playlist"><svg><use href="#i-plus"/></svg></button>
                <button class="card-action" type="button" data-action="queue" aria-label="Add ${title} to queue" title="Add to queue"><svg><use href="#i-queue"/></svg></button>
                <button class="card-action play-card" type="button" data-action="play" aria-label="Play ${title}" title="Play"><svg><use href="#i-play"/></svg></button>
            </div></div><div class="track-meta"><h3 class="track-name" title="${title}">${title}</h3></div><p class="track-artist" title="${artist}">${artist}</p></article>`;
    }).join('');
}

function renderPlaylists() {
    ui.playlistList.innerHTML = playlists.map((playlist) => `<button class="playlist-entry" type="button" data-playlist-id="${escapeHtml(playlist.id)}"><span class="playlist-art">${escapeHtml(playlist.name.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(playlist.name)}</span></button>`).join('');
    ui.likedCount.textContent = `${likedIds.length} ${likedIds.length === 1 ? 'song' : 'songs'}`;
}

function renderQueue() {
    const tracks = queuedIds.map(getTrack).filter(Boolean);
    ui.queueCount.textContent = `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`;
    ui.queueList.innerHTML = tracks.length ? tracks.map((track) => `<div class="queue-item" data-track-id="${escapeHtml(track.id)}"><img src="${escapeHtml(track.artwork)}" alt="" loading="lazy"><div class="queue-item-copy"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></div><button class="remove-queue" type="button" data-action="remove-queue" aria-label="Remove ${escapeHtml(track.title)} from queue"><svg><use href="#i-close"/></svg></button></div>`).join('') : '<div class="queue-empty">Your queue is clear.<br>Add a track with the + button.</div>';
}

function updateLikeButton() {
    const liked = currentTrack && likedIds.includes(String(currentTrack.id));
    const button = document.querySelector('#like-track');
    button.classList.toggle('is-liked', Boolean(liked));
    button.setAttribute('aria-label', liked ? 'Remove from liked songs' : 'Like track');
    button.title = liked ? 'Remove from liked songs' : 'Like track';
}

function renderNowPlaying(track) {
    if (!track) return;
    ui.cover.innerHTML = `<img src="${escapeHtml(track.artwork)}" alt="">`;
    ui.title.textContent = track.title;
    ui.artist.textContent = track.artist;
    ui.nowPlaying.innerHTML = `<img src="${escapeHtml(track.artwork)}" alt="Artwork for ${escapeHtml(track.title)}"><p>${escapeHtml(track.title)}</p><span>${escapeHtml(track.artist)} · local file</span>`;
    updateProgress();
    updateLikeButton();
}

function pageTracks() {
    const allTracks = [...tracksById.values()].sort((a, b) => b.addedAt - a.addedAt);
    if (currentView.page === 'liked') return likedIds.map(getTrack).filter(Boolean);
    if (currentView.page === 'library') return allTracks;
    if (currentView.page === 'playlist') {
        const playlist = playlists.find((item) => item.id === currentView.playlistId);
        return playlist ? playlist.trackIds.map(getTrack).filter(Boolean) : [];
    }
    if (currentView.page === 'search') {
        const query = ui.search.value.trim().toLowerCase();
        return allTracks.filter((track) => `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(query));
    }
    if (activeFilter === 'liked') return likedIds.map(getTrack).filter(Boolean);
    if (activeFilter === 'recent') return allTracks.slice(0, 12);
    return allTracks;
}

function renderPage() {
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.page === currentView.page));
    ui.hero.hidden = currentView.page !== 'home';
    if (currentView.page === 'liked') {
        ui.sectionKicker.textContent = 'YOUR COLLECTION';
        ui.sectionTitle.textContent = 'Liked songs';
        renderTrackGrid(pageTracks(), 'Your liked songs will live here. Tap a heart to save a track.');
        return;
    }
    if (currentView.page === 'playlist') {
        const playlist = playlists.find((item) => item.id === currentView.playlistId);
        if (!playlist) { currentView = { page: 'library', playlistId: null }; renderPage(); return; }
        ui.sectionKicker.textContent = 'YOUR PLAYLIST';
        ui.sectionTitle.textContent = playlist.name;
        renderTrackGrid(pageTracks(), 'This playlist is empty. Add tracks from your library.');
        return;
    }
    ui.sectionKicker.textContent = currentView.page === 'search' ? 'YOUR PERSONAL LIBRARY' : 'YOUR MUSIC, IN ONE PLACE';
    ui.sectionTitle.textContent = currentView.page === 'search' ? 'Search results' : currentView.page === 'library' ? 'Your library' : activeFilter === 'liked' ? 'Liked songs' : activeFilter === 'recent' ? 'Recently added' : 'Your library';
    currentResults = pageTracks();
    renderTrackGrid(currentResults, currentView.page === 'search' ? 'No matching tracks in your library.' : 'Add music from your device to get started. Your files stay in this browser.');
}

function parseFileName(filename) {
    const name = filename.replace(/\.[^.]+$/, '').trim();
    const parts = name.split(/\s+-\s+/, 2);
    return parts.length === 2 ? { artist: parts[0], title: parts[1] } : { artist: 'Your music', title: name || 'Untitled track' };
}

function coverFor(id) {
    let hash = 0;
    for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return COVER_ART[hash % COVER_ART.length];
}

async function importFiles(fileList) {
    const files = [...fileList].filter((file) => file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(file.name));
    if (!files.length) { showToast('Choose audio files such as MP3, M4A, WAV, OGG, or FLAC.'); return; }
    const records = files.map((file) => {
        const details = parseFileName(file.name);
        const id = crypto.randomUUID ? crypto.randomUUID() : `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`;
        return { id, title: details.title, artist: details.artist, album: 'From your device', artwork: coverFor(id), filename: file.name, size: file.size, addedAt: Date.now(), blob: file };
    });
    try {
        await storeTracks(records);
        records.forEach((record) => tracksById.set(record.id, { ...record, url: URL.createObjectURL(record.blob) }));
        activeFilter = 'all';
        document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('is-selected', chip.dataset.filter === 'all'));
        if (currentView.page !== 'home') setView('home'); else renderPage();
        renderPlaylists();
        showToast(`${records.length} ${records.length === 1 ? 'track' : 'tracks'} added to your library.`);
    } catch {
        showToast('Could not save these files. Check available browser storage and try smaller files.');
    }
}

function setView(page, playlistId = null, recordHistory = true) {
    if (recordHistory && (page !== currentView.page || playlistId !== currentView.playlistId)) { viewHistory.push(currentView); forwardHistory = []; }
    currentView = { page, playlistId };
    renderPage();
    document.querySelector('.content-scroll').scrollTo({ top: 0, behavior: 'smooth' });
}

function updateProgress() {
    const duration = Number.isFinite(ui.audio.duration) && ui.audio.duration > 0 ? ui.audio.duration : 0;
    const current = Number.isFinite(ui.audio.currentTime) ? ui.audio.currentTime : 0;
    const percent = duration ? Math.min(100, current / duration * 100) : 0;
    ui.progress.value = String(percent);
    ui.progress.style.background = `linear-gradient(to right, var(--acid) ${percent}%, #454a41 ${percent}%)`;
    ui.elapsed.textContent = formatTime(current);
    ui.duration.textContent = formatTime(duration);
}

function updatePlayButton() {
    const playing = !ui.audio.paused;
    ui.play.innerHTML = `<svg><use href="#${playing ? 'i-pause' : 'i-play'}"/></svg>`;
    ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    ui.play.title = playing ? 'Pause' : 'Play';
}

async function playTrack(track) {
    if (!track?.url) { showToast('That track is no longer in your library.'); return; }
    currentTrack = track;
    ui.audio.pause();
    ui.audio.src = track.url;
    ui.audio.load();
    renderNowPlaying(track);
    renderQueue();
    try { await ui.audio.play(); }
    catch { showToast('Playback could not start. Try playing the track again.'); }
}

function playNext() {
    let nextTrack;
    while (queuedIds.length && !nextTrack) nextTrack = getTrack(queuedIds.shift());
    if (nextTrack) { saveCollections(); renderQueue(); playTrack(nextTrack); return; }
    const tracks = currentResults.length ? currentResults : [...tracksById.values()];
    if (!tracks.length) { ui.audio.pause(); return; }
    const index = tracks.findIndex((track) => currentTrack && String(track.id) === String(currentTrack.id));
    const nextIndex = shuffleEnabled ? Math.floor(Math.random() * tracks.length) : (index + 1) % tracks.length;
    playTrack(tracks[nextIndex]);
}

function playPrevious() {
    if (ui.audio.currentTime > 3) { ui.audio.currentTime = 0; return; }
    const tracks = currentResults.length ? currentResults : [...tracksById.values()];
    if (!tracks.length) return;
    const index = tracks.findIndex((track) => currentTrack && String(track.id) === String(currentTrack.id));
    playTrack(tracks[(index - 1 + tracks.length) % tracks.length]);
}

function addToQueue(track) {
    const id = String(track.id);
    if (id === (currentTrack && String(currentTrack.id)) || queuedIds.includes(id)) { showToast('That track is already in your queue.'); return; }
    queuedIds.push(id);
    saveCollections();
    renderQueue();
    showToast(`Added “${track.title}” to your queue.`);
}

function toggleLiked(track) {
    const id = String(track.id);
    if (likedIds.includes(id)) { likedIds = likedIds.filter((item) => item !== id); showToast('Removed from liked songs.'); }
    else { likedIds.unshift(id); showToast('Added to liked songs.'); }
    saveCollections();
    renderPlaylists();
    updateLikeButton();
    if (['liked', 'playlist'].includes(currentView.page)) renderPage(); else renderTrackGrid(pageTracks());
}

function addTrackToPlaylist(track, playlistId) {
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist || !track) return;
    const id = String(track.id);
    if (!playlist.trackIds.includes(id)) playlist.trackIds.push(id);
    saveCollections();
    renderPlaylists();
    if (currentView.page === 'playlist' && currentView.playlistId === playlistId) renderPage();
    showToast(`Added to “${playlist.name}”.`);
}

function openPlaylistPicker(track) {
    pendingPlaylistTrackId = String(track.id);
    ui.pickerList.innerHTML = '';
    if (!playlists.length) {
        const empty = document.createElement('p');
        empty.className = 'picker-empty';
        empty.textContent = 'Create a playlist first, then add songs here.';
        ui.pickerList.append(empty);
    }
    playlists.forEach((playlist) => {
        const button = document.createElement('button');
        button.className = 'picker-option';
        button.type = 'button';
        button.innerHTML = `<span class="playlist-art">${escapeHtml(playlist.name.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(playlist.name)}</span>`;
        button.addEventListener('click', () => { addTrackToPlaylist(getTrack(pendingPlaylistTrackId), playlist.id); ui.pickerDialog.close(); });
        ui.pickerList.append(button);
    });
    ui.pickerDialog.showModal();
}

function createPlaylist(name) {
    const playlist = { id: `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`, name, trackIds: [] };
    if (pendingPlaylistTrackId) {
        const track = getTrack(pendingPlaylistTrackId);
        if (track) playlist.trackIds.push(String(track.id));
        pendingPlaylistTrackId = null;
    }
    playlists.unshift(playlist);
    saveCollections();
    renderPlaylists();
    showToast(`Created “${name}”.`);
}

function handleGridClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'import') { ui.fileInput.click(); return; }
    const card = button.closest('[data-track-id]');
    const track = getTrack(card?.dataset.trackId);
    if (!track) return;
    if (button.dataset.action === 'play') playTrack(track);
    if (button.dataset.action === 'queue') addToQueue(track);
    if (button.dataset.action === 'like') toggleLiked(track);
    if (button.dataset.action === 'playlist') openPlaylistPicker(track);
}

function syncVolume(value) {
    ui.audio.volume = Math.max(0, Math.min(1, Number(value) / 100));
    document.querySelector('#volume-value').textContent = String(value);
    document.querySelector('#volume-slider').style.background = `linear-gradient(to right, var(--acid) ${value}%, #454a41 ${value}%)`;
}

async function initializeLibrary() {
    const [storedResult, starterResult] = await Promise.allSettled([getAllStoredTracks(), loadStarterTracks()]);
    if (storedResult.status === 'fulfilled') {
        storedResult.value.forEach((record) => tracksById.set(String(record.id), { ...record, url: URL.createObjectURL(record.blob) }));
    }
    if (starterResult.status === 'fulfilled') {
        starterResult.value.forEach((track) => tracksById.set(track.id, track));
    }
    renderPlaylists();
    renderQueue();
    renderPage();

    if (storedResult.status === 'rejected' && starterResult.status === 'rejected') {
        ui.grid.innerHTML = '<div class="error-state"><span>This browser cannot access local music storage.</span><span>Try opening Morrow in a current browser over HTTPS.</span></div>';
    } else if (starterResult.status === 'rejected') {
        showToast('Starter music is unavailable. Add audio files from your device.');
    }
}

async function loadStarterTracks() {
    const response = await fetch(ARCHIVE_METADATA_URL);
    if (!response.ok) throw new Error('Could not load the starter catalog.');
    const data = await response.json();
    const license = String(data.metadata?.licenseurl || '').toLowerCase();
    if (!license.includes('creativecommons.org/publicdomain/zero/1.0')) throw new Error('Starter catalog license could not be verified.');

    const seen = new Set();
    return (data.files || [])
        .filter((file) => file.format === 'VBR MP3' && file.name?.toLowerCase().endsWith('.mp3'))
        .map((file) => ({ file, number: Number.parseInt(file.track, 10) }))
        .filter(({ number }) => Number.isInteger(number) && number > 0 && number <= STARTER_TRACK_LIMIT && !seen.has(number) && seen.add(number))
        .sort((first, second) => first.number - second.number)
        .map(({ file, number }) => {
            const title = String(file.title || file.name)
                .replace(/^Kimiko Ishizaka.*? - \d+\s+/, '')
                .replace(/\.mp3$/i, '');
            return {
                id: `archive-${number}`,
                title: title || `Goldberg Variation ${number}`,
                artist: 'Kimiko Ishizaka',
                album: 'The Open Goldberg Variations',
                artwork: `${ARCHIVE_DOWNLOAD_URL}/cover.jpg`,
                url: `${ARCHIVE_DOWNLOAD_URL}/${encodeURIComponent(file.name)}`,
                filename: file.name,
                size: Number(file.size) || 0,
                duration: Number.parseFloat(file.length) || 0,
                addedAt: 0,
                license: 'CC0 1.0'
            };
        })
        .slice(0, STARTER_TRACK_LIMIT);
}

renderPlaylists();
renderQueue();
syncVolume(readStorage(STORAGE_KEYS.volume, 75));
initializeLibrary();

ui.grid.addEventListener('click', handleGridClick);
ui.queueList.addEventListener('click', (event) => {
    const item = event.target.closest('.queue-item');
    if (!item) return;
    const id = String(item.dataset.trackId);
    if (event.target.closest('[data-action="remove-queue"]')) { queuedIds = queuedIds.filter((queuedId) => queuedId !== id); saveCollections(); renderQueue(); return; }
    queuedIds = queuedIds.filter((queuedId) => queuedId !== id);
    saveCollections();
    renderQueue();
    playTrack(getTrack(id));
});

document.querySelectorAll('.nav-item, .library-label, .liked-link').forEach((button) => button.addEventListener('click', () => {
    setView(button.dataset.page);
    if (button.dataset.page === 'search') ui.search.focus();
}));

document.querySelectorAll('.filter-chip').forEach((button) => button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('is-selected', chip === button));
    if (currentView.page !== 'home') setView('home'); else renderPage();
}));

ui.search.addEventListener('input', () => {
    if (currentView.page !== 'search') setView('search');
    renderPage();
});

document.querySelectorAll('#import-music, #hero-play').forEach((button) => button.addEventListener('click', () => ui.fileInput.click()));
ui.fileInput.addEventListener('change', () => { importFiles(ui.fileInput.files); ui.fileInput.value = ''; });

document.querySelector('.content-scroll').addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('is-dragging'); });
document.querySelector('.content-scroll').addEventListener('dragleave', (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('is-dragging');
});
document.querySelector('.content-scroll').addEventListener('drop', (event) => {
    event.preventDefault(); event.currentTarget.classList.remove('is-dragging'); importFiles(event.dataTransfer.files);
});

document.querySelector('#new-playlist').addEventListener('click', () => { pendingPlaylistTrackId = null; ui.playlistName.value = ''; ui.playlistDialog.showModal(); window.setTimeout(() => ui.playlistName.focus(), 50); });
document.querySelector('#picker-create').addEventListener('click', () => { ui.pickerDialog.close(); ui.playlistName.value = ''; ui.playlistDialog.showModal(); window.setTimeout(() => ui.playlistName.focus(), 50); });
document.querySelector('#picker-close').addEventListener('click', () => ui.pickerDialog.close());
ui.playlistDialog.addEventListener('close', () => { if (ui.playlistDialog.returnValue === 'create' && ui.playlistName.value.trim()) createPlaylist(ui.playlistName.value.trim()); });
document.querySelector('#playlist-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-playlist-id]');
    if (button) setView('playlist', button.dataset.playlistId);
});
document.querySelector('#playlist-form').addEventListener('submit', (event) => { if (!ui.playlistName.value.trim()) event.preventDefault(); });

ui.play.addEventListener('click', async () => {
    if (!ui.audio.src) { if (currentResults[0]) await playTrack(currentResults[0]); return; }
    if (ui.audio.paused) { try { await ui.audio.play(); } catch { showToast('Could not start playback. Try another track.'); } }
    else ui.audio.pause();
});
document.querySelector('#next-button').addEventListener('click', playNext);
document.querySelector('#previous-button').addEventListener('click', playPrevious);
document.querySelector('#like-track').addEventListener('click', () => currentTrack ? toggleLiked(currentTrack) : showToast('Play a track first to save it.'));
ui.audio.addEventListener('timeupdate', updateProgress);
ui.audio.addEventListener('loadedmetadata', updateProgress);
ui.audio.addEventListener('durationchange', updateProgress);
ui.audio.addEventListener('play', updatePlayButton);
ui.audio.addEventListener('pause', updatePlayButton);
ui.audio.addEventListener('ended', () => { if (!ui.audio.loop) playNext(); });
ui.audio.addEventListener('error', () => { if (currentTrack) showToast('This audio file could not be played. Try another format.'); });
ui.progress.addEventListener('input', () => {
    if (ui.audio.src && Number.isFinite(ui.audio.duration)) ui.audio.currentTime = Number(ui.progress.value) / 100 * ui.audio.duration;
    updateProgress();
});
document.querySelector('#volume-slider').addEventListener('input', (event) => { syncVolume(event.currentTarget.value); writeStorage(STORAGE_KEYS.volume, Number(event.currentTarget.value)); });
document.querySelector('#shuffle-button').addEventListener('click', (event) => {
    shuffleEnabled = !shuffleEnabled; event.currentTarget.classList.toggle('is-on', shuffleEnabled); showToast(shuffleEnabled ? 'Shuffle is on.' : 'Shuffle is off.');
});
document.querySelector('#repeat-button').addEventListener('click', (event) => {
    ui.audio.loop = !ui.audio.loop; event.currentTarget.classList.toggle('is-on', ui.audio.loop); showToast(ui.audio.loop ? 'Repeat is on.' : 'Repeat is off.');
});
document.querySelector('#clear-queue').addEventListener('click', () => { queuedIds = []; saveCollections(); renderQueue(); });
document.querySelector('.queue-toggle').addEventListener('click', () => document.querySelector('.right-rail').classList.toggle('is-open'));
document.querySelectorAll('.history-button').forEach((button, index) => button.addEventListener('click', () => {
    const source = index === 0 ? viewHistory : forwardHistory;
    const destination = index === 0 ? forwardHistory : viewHistory;
    const target = source.pop();
    if (!target) return;
    destination.push(currentView); currentView = target; renderPage();
}));
document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    if (event.key === '/' && !typing) { event.preventDefault(); ui.search.focus(); }
    else if (event.code === 'Space' && !typing && !ui.playlistDialog.open && !ui.pickerDialog.open) { event.preventDefault(); ui.play.click(); }
    else if (event.key === 'Escape') document.querySelector('.right-rail').classList.remove('is-open');
});