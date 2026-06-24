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

      // Upload and extract text
      this.showTypingIndicator();
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
      this.showTypingIndicator();
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
        // Extract URL
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

    // Build event card HTML
    let cardHtml = '<div class="event-card">';
    cardHtml += '<div class="event-card-title">✅ Event erfolgreich erstellt!</div>';

    const fieldOrder = [
      ['Event-Nummer', '🔢'],
      ['Event-Name', '📋'],
      ['Datum', '📅'],
      ['Ort', '📍'],
      ['Kapazitaet', '👥'],
      ['Kapazität', '👥'],
      ['Budget', '💰'],
      ['Compliance-Limite', '⚖️'],
      ['Event-Typ', '🏷️'],
      ['Status', '🔄'],
      ['Dress Code', '👔'],
      ['Catering', '🍽️']
    ];

    for (const [field, icon] of fieldOrder) {
      if (details[field]) {
        cardHtml += `<div class="event-card-row">
          <span class="event-card-label">${icon} ${field}:</span>
          <span class="event-card-value">${details[field]}</span>
        </div>`;
      }
    }

    if (salesforceLink) {
      cardHtml += `<a href="${salesforceLink}" target="_blank" class="event-card-link">
        &#x2601; Open in Salesforce
      </a>`;
    }

    cardHtml += '</div>';

    // Also show any summary text
    let summaryText = '';
    if (summaryLines.length > 0) {
      summaryText = summaryLines.join('\n');
    }

    this.addBotMessage(summaryText, cardHtml);
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

  showTypingIndicator() {
    const html = `
      <div class="message-group" id="typingIndicator">
        <div class="msg-avatar bot">&#x1F916;</div>
        <div class="msg-content">
          <div class="typing-indicator">
            <div class="typing-dots">
              <span></span><span></span><span></span>
            </div>
            <span>Briefing Agent is typing...</span>
          </div>
        </div>
      </div>`;
    this.els.messagesContainer.insertAdjacentHTML('beforeend', html);
    this.scrollToBottom();
  }

  removeTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
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
