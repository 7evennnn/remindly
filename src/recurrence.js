import { addDays, addMonths, setDate, nextDay } from 'date-fns';

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function fmt(date) {
  return date.toISOString().split('T')[0];
}

export function getNextFireDate(recurrence) {
  const today = new Date();

  if (recurrence.type === 'daily') {
    return fmt(addDays(today, 1));
  }

  if (recurrence.type === 'weekly') {
    return fmt(nextDay(today, WEEKDAYS[recurrence.weekday]));
  }

  if (recurrence.type === 'monthly_date') {
    return fmt(setDate(addMonths(today, 1), recurrence.day));
  }

  return null; // specific date - handled by deactivating the task
}