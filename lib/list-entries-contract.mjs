export function assertListEntriesPage(record, { pageSize = 100, entryType } = {}) {
  const request = record.listEntriesRequest;
  const response = record.listEntriesResponse;
  const evidence = `ListContextEntries RequestId=${record.requestId || '缺失'}`;
  if (!request || !response) throw new Error(`${evidence} 缺少请求或结果分页证据`);
  if (request.hasEntryCategory) throw new Error(`${evidence} 仍发送旧字段 EntryCategory`);

  const { entryTypes, maxResults, nextTokens } = request;
  const [size] = maxResults;
  if (entryTypes.length > 1 || entryTypes.includes(null) ||
      (entryType && entryTypes[0] !== entryType)) {
    throw new Error(`${evidence} EntryType 缺失、重复或不符合当前筛选`);
  }
  if (maxResults.length !== 1 || !Number.isSafeInteger(size) || size < 1 || size > pageSize ||
      nextTokens.length > 1 || nextTokens.includes(null)) {
    throw new Error(`${evidence} 分页参数 MaxResults 或 NextToken 超界、重复或格式有误`);
  }
  if (!Number.isSafeInteger(response.itemsCount) || response.itemsCount > size || response.itemsCount < 0) {
    const observed = response.entriesCount === null ? '未读到条目数组' : '读到 Entries';
    throw new Error(`${evidence} Result.Items 缺失或超过 MaxResults（${observed}）`);
  }
  if (typeof response.nextToken !== 'string' ||
      (response.nextToken && response.nextToken === nextTokens[0])) {
    throw new Error(`${evidence} 响应游标格式有误或回到同一页`);
  }
}

export function assertListEntriesContinuation(previous, current) {
  const cursor = previous.listEntriesResponse?.nextToken;
  const requested = current.listEntriesRequest?.nextTokens;
  if (!cursor || requested?.length !== 1 || requested[0] !== cursor) {
    throw new Error('下一页未使用本次筛选返回的 NextToken');
  }
}
