/**
 * Content script for the Salesforce AddMe extension.
 *
 * This script runs in the context of every web page.  Its sole job is to
 * monitor the page selection and forward selected text to the extension
 * when the user triggers the action (popup click or context-menu).
 *
 * The script is intentionally kept minimal to reduce page-level risk.
 * It does NOT read or modify the page DOM beyond capturing selected text.
 * No PII is stored here – text is forwarded once and discarded.
 */

(function () {
  'use strict';

  /**
   * Capture the current window selection as plain text.
   * Strips excessive whitespace but preserves line breaks (useful for
   * multi-field business cards / contact blocks).
   *
   * @returns {string}
   */
  function getSelectedText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return '';

    // Prefer the plain-text representation to avoid leaking markup.
    return selection.toString().replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  }

  /**
   * When the page loses focus (user switches to popup), save the selection.
   * This handles the case where the selection is cleared by the browser when
   * focus leaves the page.
   */
  let lastSelection = '';

  document.addEventListener('selectionchange', () => {
    const text = getSelectedText();
    if (text) lastSelection = text;
  });

  /**
   * Single combined message listener for all message types from the popup /
   * background.  Using two separate listeners would cause the second to
   * silently override the first in MV3 content scripts.
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_SELECTED_TEXT') {
      sendResponse({ text: getSelectedText() });
      return false; // synchronous response
    }

    if (message.type === 'GET_LAST_SELECTED_TEXT') {
      sendResponse({ text: lastSelection });
      return false;
    }
  });
})();
