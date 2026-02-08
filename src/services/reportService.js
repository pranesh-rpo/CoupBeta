/**
 * Report Service
 * Generates daily/weekly/monthly reports
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import broadcastStatsService from './broadcastStatsService.js';
import analyticsService from './analyticsService.js';

class ReportService {
  /**
   * Generate daily report
   */
  async generateDailyReport(accountId, date = null) {
    try {
      const reportDate = date || new Date().toISOString().split('T')[0];
      const stats = await broadcastStatsService.getTodayStats(accountId);
      const topGroups = await analyticsService.getTopGroups(accountId, 5);
      const problematic = await analyticsService.getProblematicGroups(accountId, 5);

      const report = {
        date: reportDate,
        summary: {
          messagesSent: stats.stats?.messages_sent || 0,
          messagesFailed: stats.stats?.messages_failed || 0,
          successRate: stats.stats?.success_rate || 0,
          totalGroups: stats.stats?.total_groups || 0
        },
        topGroups: topGroups.groups || [],
        problematicGroups: problematic.groups || []
      };

      return { success: true, report };
    } catch (error) {
      logger.logError('REPORT', accountId, error, 'Failed to generate daily report');
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate weekly report
   */
  async generateWeeklyReport(accountId) {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);

      const stats = await broadcastStatsService.getStats(
        accountId,
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0]
      );

      const summary = await broadcastStatsService.getSummary(accountId, 7);

      const report = {
        period: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
        summary: summary.summary || {},
        dailyStats: stats.stats || []
      };

      return { success: true, report };
    } catch (error) {
      logger.logError('REPORT', accountId, error, 'Failed to generate weekly report');
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate monthly report
   */
  async generateMonthlyReport(accountId) {
    try {
      const summary = await broadcastStatsService.getSummary(accountId, 30);
      const topGroups = await analyticsService.getTopGroups(accountId, 10);

      const report = {
        period: 'Last 30 days',
        summary: summary.summary || {},
        topGroups: topGroups.groups || []
      };

      return { success: true, report };
    } catch (error) {
      logger.logError('REPORT', accountId, error, 'Failed to generate monthly report');
      return { success: false, error: error.message };
    }
  }

  /**
   * Export report to CSV
   */
  exportToCSV(report) {
    let csv = 'Date,Messages Sent,Messages Failed,Success Rate,Total Groups\n';
    
    if (report.dailyStats) {
      report.dailyStats.forEach(stat => {
        csv += `${stat.broadcast_date},${stat.messages_sent},${stat.messages_failed},${stat.success_rate},${stat.total_groups}\n`;
      });
    } else {
      csv += `${report.date || 'N/A'},${report.summary.messagesSent || 0},${report.summary.messagesFailed || 0},${report.summary.successRate || 0},${report.summary.totalGroups || 0}\n`;
    }

    return csv;
  }
}

export default new ReportService();
