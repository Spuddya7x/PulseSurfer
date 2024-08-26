class Position {
  constructor(initialSolBalance, initialUsdcBalance, initialPrice) {
    this.solBalance = initialSolBalance;
    this.usdcBalance = initialUsdcBalance;
    this.initialValue = this.solBalance * initialPrice + this.usdcBalance;
    this.initialSolBalance = initialSolBalance;
    this.initialPrice = initialPrice;
    this.trades = [];
    this.totalSolBought = 0;
    this.totalSolSold = 0;
    this.totalUsdcSpent = 0;
    this.totalUsdcReceived = 0;
    this.solBalanceFromTrades = 0;
    this.isInitialized = true;
  }

  addTrade(tradeType, solAmount, usdcAmount, price) {
    this.trades.push({
      type: tradeType,
      solAmount,
      usdcAmount,
      price,
      timestamp: new Date()
    });

    if (tradeType === 'buy') {
      this.solBalance += solAmount;
      this.usdcBalance -= usdcAmount;
      this.totalSolBought += solAmount;
      this.totalUsdcSpent += usdcAmount;
      this.solBalanceFromTrades += solAmount;
    } else if (tradeType === 'sell') {
      this.solBalance -= solAmount;
      this.usdcBalance += usdcAmount;
      this.totalSolSold += solAmount;
      this.totalUsdcReceived += usdcAmount;
    }
  }

  getAverageEntryPrice() {
    return this.totalSolBought > 0 ? this.totalUsdcSpent / this.totalSolBought : 0;
  }

  getAverageSellPrice() {
    return this.totalSolSold > 0 ? this.totalUsdcReceived / this.totalSolSold : 0;
  }

  getRealizedPnL() {
    const avgEntryPrice = this.getAverageEntryPrice();
    return avgEntryPrice > 0 ? this.totalUsdcReceived - (avgEntryPrice * this.totalSolSold) : 0;
  }

  getUnrealizedPnL(currentPrice) {
    const avgEntryPrice = this.getAverageEntryPrice();
    if (avgEntryPrice === 0) {
      return (currentPrice - this.initialPrice) * this.initialSolBalance;
    }
    return (currentPrice - avgEntryPrice) * this.solBalanceFromTrades;
  }

  getTotalPnL(currentPrice) {
    const currentValue = this.getCurrentValue(currentPrice);
    return currentValue - this.initialValue;
  }

  getCurrentValue(currentPrice) {
    return this.solBalance * currentPrice + this.usdcBalance;
  }

  getPerformanceMetrics(currentPrice) {
    const currentValue = this.getCurrentValue(currentPrice);
    const totalPnL = this.getTotalPnL(currentPrice);
    const percentageReturn = (totalPnL / this.initialValue) * 100;
    const avgEntryPrice = this.getAverageEntryPrice();

    return {
      currentValue: currentValue.toFixed(2),
      totalPnL: totalPnL.toFixed(2),
      percentageReturn: percentageReturn.toFixed(2),
      realizedPnL: this.getRealizedPnL().toFixed(2),
      unrealizedPnL: this.getUnrealizedPnL(currentPrice).toFixed(2),
      averageEntryPrice: avgEntryPrice > 0 ? avgEntryPrice.toFixed(2) : 'N/A',
      averageSellPrice: this.getAverageSellPrice().toFixed(2),
      solBalance: this.solBalance.toFixed(6),
      usdcBalance: this.usdcBalance.toFixed(2)
    };
  }
}

module.exports = Position;