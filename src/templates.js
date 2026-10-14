/**
 * THE CLUB 777° — REMINDER MESSAGE TEMPLATES & PLACEHOLDER ENGINE
 * Minimal PII, clear operational information, and standard opt-out footer.
 */

export const DEFAULT_TEMPLATES = {
  expiring_7d: {
    title: 'Membership Expiring in 7 Days',
    template: `Hello {member_name},

This is a friendly reminder that your *{plan_title}* at *{gym_name}* is scheduled to expire in 7 days on *{end_date}*.

To ensure continuous access to your workout routines and fitness coaching, please renew your membership at the front desk or contact us.

📞 Helpdesk: {gym_phone}
_Note: To opt out of automated reminders, reply STOP._`
  },

  expiring_3d: {
    title: 'Membership Expiring in 3 Days',
    template: `Hello {member_name},

Your *{plan_title}* at *{gym_name}* will conclude in 3 days on *{end_date}*.

Avoid interruption to your fitness progress by renewing early at reception.

📞 Helpline: {gym_phone}
_Note: To opt out of automated reminders, reply STOP._`
  },

  expiring_tomorrow: {
    title: 'Membership Expiring Tomorrow',
    template: `Dear {member_name},

Your gym membership (*{plan_title}*) at *{gym_name}* ends tomorrow, *{end_date}*.

Please visit the reception today to renew and maintain seamless gym and locker access.

📞 Front Desk: {gym_phone}
_Note: To opt out of automated reminders, reply STOP._`
  },

  expiring_today: {
    title: 'Membership Expiring Today',
    template: `Dear {member_name},

Your *{plan_title}* at *{gym_name}* expires today, *{end_date}*.

Kindly renew at the front desk today to keep your attendance active and avoid biometric lock.

📞 Contact: {gym_phone}
_Note: To opt out of automated reminders, reply STOP._`
  },

  expired: {
    title: 'Membership Expired Notice',
    template: `Dear {member_name},

Your membership at *{gym_name}* (*{plan_title}*) concluded on *{end_date}*.

We miss seeing you on the gym floor! Re-activate your plan at the front desk to resume training.

📞 Reception: {gym_phone}
_Note: To opt out of automated reminders, reply STOP._`
  },

  pending_dues: {
    title: 'Pending Fee Balance Notice',
    template: `Hello {member_name},

Our records indicate an outstanding balance of *₹{due_amount}* for your membership at *{gym_name}*.

Kindly clear this at your earliest convenience at the reception.

📞 Reception: {gym_phone}
_Note: To opt out of automated reminders, reply STOP._`
  },

  renewal_confirmation: {
    title: 'Membership Renewal Confirmation',
    template: `Thank you, {member_name}!

Your membership *{plan_title}* at *{gym_name}* has been successfully renewed through *{end_date}*.

Keep up the great work and stay consistent! 💪

📞 Reception: {gym_phone}`
  }
};

/**
 * Normalizes phone numbers to standard format (e.g. 919876543210 for India)
 * @param {string|number} phone 
 * @returns {string|null} Normalized phone or null if invalid
 */
export function normalizePhoneNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length === 10) {
    return '91' + digits; // Default India Country Code
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits;
  }
  if (digits.length >= 11 && digits.length <= 15) {
    return digits;
  }
  return null;
}

/**
 * Renders a template with safe placeholder replacement
 * @param {string} templateString 
 * @param {Object} data 
 * @returns {string}
 */
export function renderTemplate(templateString, data = {}) {
  let rendered = String(templateString || '');
  for (const [key, value] of Object.entries(data)) {
    const placeholder = new RegExp(`\\{${key}\\}`, 'g');
    rendered = rendered.replace(placeholder, value !== null && value !== undefined ? String(value) : '');
  }
  // Clean up any remaining unsupplied placeholders
  rendered = rendered.replace(/\{[a-zA-Z0-9_]+\}/g, '');
  return rendered.trim();
}

/**
 * Formats a Date object to DD MMM YYYY in IST
 * @param {Date|string} dateInput 
 * @returns {string} e.g. "21 Oct 2026"
 */
export function formatDateIST(dateInput) {
  if (!dateInput) return '';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}
