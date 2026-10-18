import { z } from "zod";

export const toolPolicies = {
  get_unpaid_customers: { risk: "low", operation: "read" },
  get_customer: { risk: "low", operation: "read" },
  delete_customer: { risk: "critical", operation: "delete" },
  refund_customer: { risk: "high", operation: "financial_write" },
} as const;

export type ToolName = keyof typeof toolPolicies;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolPolicies, name);
}

const customerArguments = z.strictObject({ customerId: z.number().int().positive() });
export const toolArgumentSchemas = {
  get_unpaid_customers: z.strictObject({}),
  get_customer: customerArguments,
  delete_customer: customerArguments,
  refund_customer: customerArguments,
};

const customers = [
  { id: 1, name: "Alice", unpaid: 120 },
  { id: 2, name: "Bob", unpaid: 70 },
];

// Internal mock dispatcher. Only safe_execute is exposed over MCP.
export async function executeMockTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  if (!isToolName(toolName)) throw new Error("Unknown mock tool");
  toolArgumentSchemas[toolName].parse(args);
  switch (toolName) {
    case "get_unpaid_customers":
      return customers.map((customer) => ({ ...customer }));
    case "get_customer":
      return customers.find((customer) => customer.id === args.customerId) ?? null;
    case "delete_customer":
      return { success: true, message: "Customer deleted", customerId: args.customerId };
    case "refund_customer":
      return { success: true, message: "Customer refunded", customerId: args.customerId };
  }
}
