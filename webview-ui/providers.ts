/**
 * Provider state and rendering module.
 * Manages the provider list, model dropdown, and provider form.
 */

import { escapeHtml } from './utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  toolUse: boolean;
  context: number;
}

// ── Module state ──────────────────────────────────────────────────────────────

export let providers: ProviderConfig[] = [];
export let activeProviderIndex = 0;
let editingProviderIndex = -1; // -1 = adding new
let currentProviderStatus: 'online' | 'offline' | 'checking' | 'unknown' = 'unknown';

// DOM refs — set by initProviders()
let providersList: HTMLUListElement;
let modelSelect: HTMLSelectElement;
let providerStatusDot: HTMLElement;
let providerForm: HTMLElement;
let providerFormTitle: HTMLElement;
let pfName: HTMLInputElement;
let pfBaseUrl: HTMLInputElement;
let pfModel: HTMLInputElement;
let pfApiKey: HTMLInputElement;
let pfToolUse: HTMLInputElement;
let pfContext: HTMLInputElement;
let vscodeApi: { postMessage(msg: unknown): void };

// ── Init ──────────────────────────────────────────────────────────────────────

export interface ProviderRefs {
  providersList: HTMLUListElement;
  modelSelect: HTMLSelectElement;
  providerStatusDot: HTMLElement;
  providerForm: HTMLElement;
  providerFormTitle: HTMLElement;
  pfName: HTMLInputElement;
  pfBaseUrl: HTMLInputElement;
  pfModel: HTMLInputElement;
  pfApiKey: HTMLInputElement;
  pfToolUse: HTMLInputElement;
  pfContext: HTMLInputElement;
  vscode: { postMessage(msg: unknown): void };
}

export function initProviders(refs: ProviderRefs): void {
  providersList = refs.providersList;
  modelSelect = refs.modelSelect;
  providerStatusDot = refs.providerStatusDot;
  providerForm = refs.providerForm;
  providerFormTitle = refs.providerFormTitle;
  pfName = refs.pfName;
  pfBaseUrl = refs.pfBaseUrl;
  pfModel = refs.pfModel;
  pfApiKey = refs.pfApiKey;
  pfToolUse = refs.pfToolUse;
  pfContext = refs.pfContext;
  vscodeApi = refs.vscode;
}

// ── Functions ─────────────────────────────────────────────────────────────────

export function setProviders(newProviders: ProviderConfig[], newActiveIndex: number): void {
  providers = newProviders;
  activeProviderIndex = newActiveIndex;
}

export function setActiveProviderIndex(idx: number): void {
  activeProviderIndex = idx;
}

export function renderProvidersList(): void {
  providersList.innerHTML = '';
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="provider-item-name">${escapeHtml(p.name)}</span>
      <span class="provider-item-actions">
        <button data-idx="${i}" class="btn-edit-provider" aria-label="Edit ${escapeHtml(p.name)}">Edit</button>
        <button data-idx="${i}" class="btn-delete-provider" aria-label="Delete ${escapeHtml(p.name)}">×</button>
      </span>
    `;
    providersList.appendChild(li);
  }

  providersList.querySelectorAll('.btn-edit-provider').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx ?? '0', 10);
      openProviderForm(idx);
    });
  });

  providersList.querySelectorAll('.btn-delete-provider').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx ?? '0', 10);
      providers.splice(idx, 1);
      if (activeProviderIndex >= providers.length) {
        activeProviderIndex = Math.max(0, providers.length - 1);
      }
      vscodeApi.postMessage({ type: 'saveSettings', providers });
      renderProvidersList();
      renderModelDropdown();
      triggerProviderStatusCheck();
    });
  });
}

export function triggerProviderStatusCheck(): void {
  if (providers.length === 0) { return; }
  setProviderStatus('checking');
  vscodeApi.postMessage({ type: 'selectModel', providerIndex: activeProviderIndex });
}

export function renderModelDropdown(): void {
  const prev = modelSelect.value;
  modelSelect.innerHTML = '';
  // Create a mapping: sorted display index -> original provider index
  const sortedIndices = [...providers].map((_, i) => i).sort((a, b) => providers[a].name.localeCompare(providers[b].name));
  for (let i = 0; i < sortedIndices.length; i++) {
    const opt = document.createElement('option');
    opt.value = String(sortedIndices[i]); // Use original provider index as value
    opt.textContent = providers[sortedIndices[i]].name;
    modelSelect.appendChild(opt);
  }
  // Restore selection or use activeProviderIndex
  if (prev && modelSelect.querySelector(`option[value="${prev}"]`)) {
    modelSelect.value = prev;
  } else {
    modelSelect.value = String(activeProviderIndex);
  }
  updateProviderStatusVisibility();
}

export function setProviderStatus(status: 'online' | 'offline' | 'checking' | 'unknown'): void {
  currentProviderStatus = status;
  providerStatusDot.className = `status-dot status-${status}`;
  const labels: Record<string, string> = { online: 'Online', offline: 'Offline', checking: 'Checking...', unknown: 'Unknown' };
  providerStatusDot.title = labels[status] ?? 'Unknown';
}

export function getProviderStatus(): 'online' | 'offline' | 'checking' | 'unknown' {
  return currentProviderStatus;
}

export function updateProviderStatusVisibility(): void {
  const hasValidSelection = providers.length > 0 && activeProviderIndex >= 0 && activeProviderIndex < providers.length;
  if (hasValidSelection) {
    providerStatusDot.classList.remove('hidden');
  } else {
    providerStatusDot.classList.add('hidden');
  }
}

export function openProviderForm(idx: number): void {
  editingProviderIndex = idx;
  if (idx === -1) {
    providerFormTitle.textContent = 'Add Provider';
    pfName.value = '';
    pfBaseUrl.value = '';
    pfModel.value = '';
    pfApiKey.value = '';
    pfToolUse.checked = true;
    pfContext.value = '32768';
  } else {
    const p = providers[idx];
    providerFormTitle.textContent = 'Edit Provider';
    pfName.value = p.name;
    pfBaseUrl.value = p.baseUrl;
    pfModel.value = p.model;
    pfApiKey.value = p.apiKey ?? '';
    pfToolUse.checked = p.toolUse;
    pfContext.value = String(p.context);
  }
  providerForm.hidden = false;
  pfName.focus();
}

export function closeProviderForm(): void {
  providerForm.hidden = true;
  editingProviderIndex = -1;
}

export function getEditingProviderIndex(): number {
  return editingProviderIndex;
}
