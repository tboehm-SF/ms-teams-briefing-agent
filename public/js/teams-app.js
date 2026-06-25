/**
 * MS Teams Briefing Agent - Frontend Application
 * Connects to Salesforce Agentforce via Agent API
 * Auto sign-in — no manual authentication required
 */

class TeamsApp {
  constructor() {
    this.authenticated = false;
    this.sessionId = null;
    this.uploadedFile = null;
    this.extractedText = null;
    this.isProcessing = false;

    this.els = {
      messagesContainer: document.getElementById('messagesContainer'),
      welcomeSection: document.getElementById('welcomeSection'),
      messageInput: document.getElementById('messageInput'),
      sendBtn: document.getElementById('sendBtn'),
      attachBtn: document.getElementById('attachBtn'),
      fileInput: document.getElementById('fileInput'),
      fileUploadArea: document.getElementById('fileUploadArea'),
      fileUploadName: document.getElementById('fileUploadName'),
      fileUploadRemove: document.getElementById('fileUploadRemove'),
      fileTypeIcon: document.getElementById('fileTypeIcon'),
      connectionStatus: document.getElementById('connectionStatus'),
      orgBadge: document.getElementById('orgBadge'),
      orgBadgeText: document.getElementById('orgBadgeText'),
      profileInitial: document.getElementById('profileInitial')
    };

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.connectToSalesforce();
  }

  bindEvents() {
    // Send message
    this.els.sendBtn.addEventListener('click', () => this.handleSend());
    this.els.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // Auto-resize textarea
    this.els.messageInput.addEventListener('input', () => {
      this.els.messageInput.style.height = 'auto';
      this.els.messageInput.style.height = this.els.messageInput.scrollHeight + 'px';
      this.updateSendBtn();
    });

    // File attach
    this.els.attachBtn.addEventListener('click', () => this.els.fileInput.click());
    this.els.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
    this.els.fileUploadRemove.addEventListener('click', () => this.removeFile());
  }

  async connectToSalesforce() {
    this.els.connectionStatus.textContent = 'Connecting...';
    this.els.connectionStatus.style.color = '#c8c6c4';

    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();

      this.authenticated = data.authenticated;

      if (this.authenticated) {
        this.els.connectionStatus.textContent = 'Online';
        this.els.connectionStatus.style.color = '#92c353';

        if (data.username) {
          this.els.profileInitial.textContent = data.username.charAt(0).toUpperCase();
        }

        // Show org badge
        this.els.orgBadge.style.display = 'flex';
        this.els.orgBadgeText.textContent = `Connected to ${data.instanceUrl ? new URL(data.instanceUrl).hostname.split('.')[0] : 'Salesforce'}`;

        // Create agent session
        await this.createAgentSession();
      } else {
        // Not authenticated — redirect to login page
        window.location.href = '/login';
      }
    } catch (err) {
      console.error('Connection check failed:', err);
      this.els.connectionStatus.textContent = 'Connection failed';
      this.els.connectionStatus.style.color = '#c4314b';
      this.addSystemMessage('Could not connect to server. Please refresh the page.');
    }
  }

  async createAgentSession() {
    try {
      this.els.connectionStatus.textContent = 'Connecting to agent...';

      const res = await fetch('/api/agent/session', { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        this.sessionId = data.sessionId;
        this.els.connectionStatus.textContent = 'Online';
        this.els.connectionStatus.style.color = '#92c353';
        this.addBotMessage('Willkommen! Ich bin der Briefing Agent. Laden Sie ein Briefing-Dokument hoch (PDF, Word, Excel), und ich werde die Event-Details extrahieren und das Event in Salesforce erstellen.\n\nKlicken Sie auf das 📎 Symbol, um eine Datei hochzuladen.');
      } else {
        throw new Error(data.error || 'Session creation failed');
      }
    } catch (err) {
      console.error('Agent session error:', err);
      this.els.connectionStatus.textContent = 'Agent unavailable';
      this.els.connectionStatus.style.color = '#c4314b';
      this.addSystemMessage('Could not connect to the Briefing Agent. Please try refreshing the page.');
    }
  }

  async handleSend() {
    const text = this.els.messageInput.value.trim();
    if (!text && !this.uploadedFile) return;
    if (this.isProcessing) return;

    if (!this.authenticated) {
      this.addSystemMessage('Not connected to Salesforce yet. Please wait...');
      return;
    }

    this.isProcessing = true;

    // If we have a file, upload and process it first
    if (this.uploadedFile) {
      const fileName = this.uploadedFile.name;
      const fileSize = this.formatFileSize(this.uploadedFile.size);

      // Show file attachment in chat
      this.addFileMessage(fileName, fileSize);

      // Upload and extract text — start thinking sequence
      this.startThinkingSequence();
      try {
        const formData = new FormData();
        formData.append('file', this.uploadedFile);

        const uploadRes = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });
        const uploadData = await uploadRes.json();

        if (uploadData.success) {
          this.extractedText = uploadData.text;
          this.removeFile();

          // Combine extracted text with any user message
          let agentMessage = '';
          if (text) {
            agentMessage = text + '\n\n--- Briefing Document Content ---\n' + this.extractedText;
          } else {
            agentMessage = 'Hier ist das Briefing-Dokument. Bitte extrahiere die Event-Details und erstelle das Event in Salesforce:\n\n--- Briefing Document Content ---\n' + this.extractedText;
          }

          // Clear input
          this.els.messageInput.value = '';
          this.els.messageInput.style.height = 'auto';
          this.updateSendBtn();

          // Send to agent
          await this.sendToAgent(agentMessage, text || `📎 ${fileName}`);
        } else {
          throw new Error(uploadData.error || 'File processing failed');
        }
      } catch (err) {
        this.removeTypingIndicator();
        this.addSystemMessage('Error processing file: ' + err.message);
        this.isProcessing = false;
      }
    } else {
      // Text-only message
      this.addUserMessage(text);
      this.els.messageInput.value = '';
      this.els.messageInput.style.height = 'auto';
      this.updateSendBtn();
      this.showTypingIndicator('thinking');
      await this.sendToAgent(text);
    }
  }

  async sendToAgent(fullMessage, displayText) {
    try {
      if (!this.sessionId) {
        await this.createAgentSession();
        if (!this.sessionId) throw new Error('No active session');
      }

      const res = await fetch('/api/agent/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          message: fullMessage
        })
      });

      const data = await res.json();
      this.removeTypingIndicator();

      if (data.success && data.response) {
        this.renderAgentResponse(data.response);
      } else if (data.needsReauth) {
        this.addSystemMessage('Salesforce session expired. Redirecting to login...');
        this.authenticated = false;
        setTimeout(() => { window.location.href = '/login'; }, 1500);
        return;
      } else {
        throw new Error(data.error || 'No response from agent');
      }
    } catch (err) {
      this.removeTypingIndicator();
      console.error('Agent message error:', err);
      this.addSystemMessage('Error communicating with agent: ' + (err.message || 'Unknown error'));
    } finally {
      this.isProcessing = false;
    }
  }

  renderAgentResponse(response) {
    const text = response.text || '';

    // Check if response contains event creation details
    if (text.includes('Event erfolgreich erstellt') || text.includes('Event-Nummer') || response.hasEventLink) {
      this.renderEventCard(text);
    } else {
      this.addBotMessage(text);
    }
  }

  renderEventCard(text) {
    // Parse the structured response
    const lines = text.split('\n').filter(l => l.trim());
    const details = {};
    let salesforceLink = '';
    let summaryLines = [];
    let inSummary = true;

    for (const line of lines) {
      const trimmed = line.trim();
      // Match **Label:** Value pattern
      const match = trimmed.match(/\*\*(.+?):\*\*\s*(.+)/);
      if (match) {
        details[match[1].trim()] = match[2].trim();
        inSummary = false;
      } else if (trimmed.includes('lightning.force.com') || trimmed.includes('Event_Instance__c')) {
        const urlMatch = trimmed.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) salesforceLink = urlMatch[1];
        inSummary = false;
      } else if (trimmed.startsWith('**Salesforce Link:**')) {
        const urlMatch = trimmed.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) salesforceLink = urlMatch[1];
      } else if (inSummary && trimmed.length > 0) {
        summaryLines.push(trimmed);
      }
    }

    // Also check for link in details
    if (details['Salesforce Link']) {
      const urlMatch = details['Salesforce Link'].match(/(https?:\/\/[^\s]+)/);
      if (urlMatch) salesforceLink = urlMatch[1];
    }

    // Build enhanced event card HTML
    let cardHtml = '<div class="event-card-enhanced">';

    // ── Success header with checkmark animation ──
    cardHtml += `
      <div class="event-card-header">
        <div class="event-card-header-icon">
          <span class="checkmark-animated">✓</span>
        </div>
        <div class="event-card-header-text">
          <div class="event-card-header-title">Event erfolgreich erstellt!</div>
          <div class="event-card-header-subtitle">${details['Event-Name'] || 'Neues Event'}</div>
        </div>
        ${details['Event-Nummer'] ? `<div class="event-card-badge">${details['Event-Nummer']}</div>` : ''}
      </div>`;

    // ── Key details section (top-level overview) ──
    const keyFields = [
      { key: 'Datum', icon: '📅', label: 'Datum' },
      { key: 'Ort', icon: '📍', label: 'Ort' },
      { key: 'Event-Typ', icon: '🏷️', label: 'Event-Typ' },
      { key: 'Status', icon: '🔄', label: 'Status' }
    ];

    const availableKeyFields = keyFields.filter(f => details[f.key]);
    if (availableKeyFields.length > 0) {
      cardHtml += '<div class="event-card-overview">';
      for (const f of availableKeyFields) {
        let value = details[f.key];
        // Format date nicely
        if (f.key === 'Datum') {
          value = this.formatEventDate(value);
        }
        // Color-code status
        const statusClass = f.key === 'Status' ? ' status-badge status-' + value.toLowerCase() : '';
        cardHtml += `
          <div class="event-overview-item">
            <span class="overview-icon">${f.icon}</span>
            <div class="overview-content">
              <span class="overview-label">${f.label}</span>
              <span class="overview-value${statusClass}">${value}</span>
            </div>
          </div>`;
      }
      cardHtml += '</div>';
    }

    // ── Details grid section ──
    const detailFields = [
      { keys: ['Kapazitaet', 'Kapazität'], icon: '👥', label: 'Kapazität' },
      { keys: ['Budget'], icon: '💰', label: 'Budget' },
      { keys: ['Compliance-Limite'], icon: '⚖️', label: 'Compliance-Limite' },
      { keys: ['Dress Code'], icon: '👔', label: 'Dress Code' },
      { keys: ['Catering'], icon: '🍽️', label: 'Catering' }
    ];

    const availableDetails = detailFields.filter(f => f.keys.some(k => details[k]));
    if (availableDetails.length > 0) {
      cardHtml += `<div class="event-card-section">
        <div class="event-card-section-title">Details</div>
        <div class="event-card-details-grid">`;
      for (const f of availableDetails) {
        const value = f.keys.map(k => details[k]).find(v => v);
        cardHtml += `
          <div class="event-detail-item">
            <span class="detail-icon">${f.icon}</span>
            <span class="detail-label">${f.label}</span>
            <span class="detail-value">${value}</span>
          </div>`;
      }
      cardHtml += '</div></div>';
    }

    // ── Translation status section ──
    const hasTranslation = details['Übersetzungen'];
    if (hasTranslation) {
      const isTranslated = hasTranslation.includes('✅');
      cardHtml += `
        <div class="event-card-section">
          <div class="event-card-section-title">Übersetzungen</div>
          <div class="translation-status ${isTranslated ? 'translated' : 'pending'}">
            <div class="translation-icon">${isTranslated ? '🌐' : '⏳'}</div>
            <div class="translation-info">
              <span class="translation-label">${isTranslated ? 'Automatisch übersetzt' : 'Übersetzung ausstehend'}</span>
              <div class="translation-langs">
                <span class="lang-chip">🇩🇪 DE</span>
                <span class="lang-arrow">→</span>
                <span class="lang-chip ${isTranslated ? 'done' : ''}">🇫🇷 FR</span>
                <span class="lang-chip ${isTranslated ? 'done' : ''}">🇮🇹 IT</span>
                <span class="lang-chip ${isTranslated ? 'done' : ''}">🇬🇧 EN</span>
              </div>
            </div>
          </div>
        </div>`;
    }

    // ── Salesforce link button ──
    if (salesforceLink) {
      cardHtml += `
        <div class="event-card-actions">
          <a href="${salesforceLink}" target="_blank" class="event-card-link-enhanced">
            <span class="sf-icon">☁</span> In Salesforce öffnen
          </a>
        </div>`;
    }

    // ── Timestamp footer ──
    cardHtml += `
      <div class="event-card-footer">
        <span class="event-card-timestamp">Erstellt: ${new Date().toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      </div>`;

    cardHtml += '</div>';

    // Also show any summary text
    let summaryText = '';
    if (summaryLines.length > 0) {
      summaryText = summaryLines.join('\n');
    }

    this.addBotMessage(summaryText, cardHtml);
  }

  /**
   * Format ISO date string to a nice German format
   */
  formatEventDate(dateStr) {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      const options = { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' };
      let formatted = d.toLocaleDateString('de-CH', options);
      // Add time if not midnight
      if (d.getHours() !== 0 || d.getMinutes() !== 0) {
        formatted += ', ' + d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
      }
      return formatted;
    } catch (e) {
      return dateStr;
    }
  }

  // ===== MESSAGE RENDERING =====

  addUserMessage(text) {
    this.hideWelcome();
    const time = this.formatTime();
    const html = `
      <div class="message-group self">
        <div class="msg-avatar self">You</div>
        <div class="msg-content">
          <div class="msg-sender">You <span class="msg-time">${time}</span></div>
          <div class="msg-bubble">${this.escapeHtml(text)}</div>
        </div>
      </div>`;
    this.els.messagesContainer.insertAdjacentHTML('beforeend', html);
    this.scrollToBottom();
  }

  addFileMessage(fileName, fileSize) {
    this.hideWelcome();
    const time = this.formatTime();
    const icon = this.getFileIcon(fileName);
    const html = `
      <div class="message-group self">
        <div class="msg-avatar self">You</div>
        <div class="msg-content">
          <div class="msg-sender">You <span class="msg-time">${time}</span></div>
          <div class="msg-file-attachment">
            <span class="file-icon">${icon}</span>
            <div class="file-info">
              <div class="file-name">${this.escapeHtml(fileName)}</div>
              <div class="file-size">${fileSize}</div>
            </div>
          </div>
        </div>
      </div>`;
    this.els.messagesContainer.insertAdjacentHTML('beforeend', html);
    this.scrollToBottom();
  }

  addBotMessage(text, extraHtml = '') {
    this.hideWelcome();
    const time = this.formatTime();
    const formattedText = this.formatBotText(text);
    const html = `
      <div class="message-group">
        <div class="msg-avatar bot">&#x1F916;</div>
        <div class="msg-content">
          <div class="msg-sender">Briefing Agent <span class="msg-time">${time}</span></div>
          ${formattedText ? `<div class="msg-bubble">${formattedText}</div>` : ''}
          ${extraHtml}
        </div>
      </div>`;
    this.els.messagesContainer.insertAdjacentHTML('beforeend', html);
    this.scrollToBottom();
  }

  addSystemMessage(text) {
    const html = `
      <div style="text-align:center; padding:8px; font-size:12px; color:var(--teams-text-tertiary);">
        ${this.escapeHtml(text)}
      </div>`;
    this.els.messagesContainer.insertAdjacentHTML('beforeend', html);
    this.scrollToBottom();
  }

  showTypingIndicator(phase = 'thinking') {
    // Track when indicator first appeared (for minimum display time)
    if (!this._thinkingStartTime) {
      this._thinkingStartTime = Date.now();
    }

    // Phase messages with icons for the multi-step process
    const phases = {
      thinking:   { icon: '🧠', text: 'Briefing Agent denkt nach...',           color: '#5b5fc7' },
      analyzing:  { icon: '🔍', text: 'Briefing-Dokument wird analysiert...',    color: '#5b5fc7' },
      extracting: { icon: '📋', text: 'Event-Details werden extrahiert...',      color: '#5b5fc7' },
      creating:   { icon: '☁️', text: 'Event wird in Salesforce erstellt...',    color: '#92c353' },
      translating:{ icon: '🌐', text: 'Beschreibungen werden übersetzt...',      color: '#7579eb' },
      finishing:   { icon: '✨', text: 'Wird abgeschlossen...',                  color: '#92c353' }
    };
    const p = phases[phase] || phases.thinking;

    const html = `
      <div class="message-group" id="typingIndicator">
        <div class="msg-avatar bot">&#x1F916;</div>
        <div class="msg-content">
          <div class="thinking-indicator">
            <div class="thinking-icon-wrap">
              <span class="thinking-icon">${p.icon}</span>
              <div class="thinking-pulse" style="background:${p.color}"></div>
            </div>
            <div class="thinking-text-wrap">
              <span class="thinking-text">${p.text}</span>
              <div class="thinking-progress">
                <div class="thinking-progress-bar" style="background:${p.color}"></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    // Remove existing indicator before adding new one
    const existing = document.getElementById('typingIndicator');
    if (existing) existing.remove();

    this.els.messagesContainer.insertAdjacentHTML('beforeend', html);
    this.scrollToBottom();
  }

  updateTypingPhase(phase) {
    this.showTypingIndicator(phase);
  }

  /**
   * Cycle through thinking phases automatically for file uploads.
   * Guarantees a minimum display time so the user always sees the phases.
   */
  startThinkingSequence() {
    this.thinkingPhaseIndex = 0;
    this._thinkingStartTime = Date.now();
    this._pendingRemove = false;

    const fileSequence = ['analyzing', 'extracting', 'creating', 'translating', 'finishing'];
    const delays =       [3000,        3000,         3500,       3000,          2500];

    this.showTypingIndicator(fileSequence[0]);

    const advancePhase = () => {
      this.thinkingPhaseIndex++;
      if (this.thinkingPhaseIndex < fileSequence.length && document.getElementById('typingIndicator')) {
        this.showTypingIndicator(fileSequence[this.thinkingPhaseIndex]);
        this._thinkingTimer = setTimeout(advancePhase, delays[this.thinkingPhaseIndex]);
      } else if (this._pendingRemove) {
        // All phases done and removal was requested — now remove
        this._doRemoveIndicator();
      }
    };

    this._thinkingTimer = setTimeout(advancePhase, delays[0]);
  }

  /**
   * Internal: actually remove the indicator element
   */
  _doRemoveIndicator() {
    if (this._thinkingTimer) {
      clearTimeout(this._thinkingTimer);
      this._thinkingTimer = null;
    }
    this._pendingRemove = false;
    this._thinkingStartTime = null;
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
  }

  removeTypingIndicator() {
    const MIN_DISPLAY_MS = 3000; // minimum 3 seconds visible
    const elapsed = Date.now() - (this._thinkingStartTime || 0);

    if (this._thinkingStartTime && elapsed < MIN_DISPLAY_MS) {
      // Too soon — wait until minimum time has passed, then remove
      this._pendingRemove = true;
      setTimeout(() => {
        this._doRemoveIndicator();
      }, MIN_DISPLAY_MS - elapsed);
    } else {
      this._doRemoveIndicator();
    }
  }

  // ===== FILE HANDLING =====

  handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    this.uploadedFile = file;
    this.els.fileUploadName.textContent = file.name;
    this.els.fileTypeIcon.textContent = this.getFileIcon(file.name);
    this.els.fileUploadArea.classList.add('visible');
    this.updateSendBtn();

    // Reset input so same file can be re-selected
    this.els.fileInput.value = '';
  }

  removeFile() {
    this.uploadedFile = null;
    this.extractedText = null;
    this.els.fileUploadArea.classList.remove('visible');
    this.els.fileUploadName.textContent = '';
    this.updateSendBtn();
  }

  getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
      'pdf': '📕',
      'docx': '📘',
      'doc': '📘',
      'xlsx': '📗',
      'xls': '📗',
      'csv': '📊',
      'txt': '📄'
    };
    return icons[ext] || '📄';
  }

  // ===== UTILITIES =====

  updateSendBtn() {
    const hasContent = this.els.messageInput.value.trim().length > 0 || this.uploadedFile;
    this.els.sendBtn.classList.toggle('active', hasContent);
  }

  hideWelcome() {
    if (this.els.welcomeSection) {
      this.els.welcomeSection.style.display = 'none';
    }
  }

  scrollToBottom() {
    const container = this.els.messagesContainer;
    setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 50);
  }

  formatTime() {
    return new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  }

  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  formatBotText(text) {
    if (!text) return '';
    let html = this.escapeHtml(text);
    // Bold: **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Links
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
    // Newlines
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showNotification(msg, type) {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed; top: 40px; right: 20px; z-index: 9999;
      padding: 12px 20px; border-radius: 6px; font-size: 13px;
      color: white; max-width: 360px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: slideIn 0.3s ease;
      background: ${type === 'success' ? '#92c353' : type === 'error' ? '#c4314b' : '#5b5fc7'};
    `;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, 4000);
  }
}

// Boot the app
document.addEventListener('DOMContentLoaded', () => {
  window.teamsApp = new TeamsApp();
});
