import { render, screen } from '@testing-library/react';
const OrderList = () => <div>Order List</div>;

describe('OrderList', () => {
  it('renders order list', () => {
    render(<OrderList />);
    expect(screen.getByText('Order List')).toBeInTheDocument();
  });
});
