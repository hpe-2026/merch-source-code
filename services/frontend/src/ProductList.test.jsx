import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import axios from 'axios';
import ProductList from './components/ProductList';

jest.mock('axios');

const mockProducts = [
  {
    _id: '1',
    name: 'NITTE T-Shirt',
    description: 'Cotton t-shirt',
    price: 500,
    category: 'apparel',
    stock: 10,
    image_url: 'tshirt.png',
  },
  {
    _id: '2',
    name: 'NITTE Mug',
    description: 'Ceramic mug',
    price: 200,
    category: 'accessories',
    stock: 0,
    image_url: 'mug.png',
  },
];

describe('ProductList', () => {
  const mockOnAddToCart = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders loading state initially', () => {
    axios.get.mockImplementation(() => new Promise(() => {})); // Never resolves
    render(<ProductList onAddToCart={mockOnAddToCart} />);
    expect(screen.getByText(/Loading the collection/i)).toBeInTheDocument();
  });

  it('renders products fetched from API', async () => {
    axios.get.mockResolvedValue({ data: { data: mockProducts } });
    render(<ProductList onAddToCart={mockOnAddToCart} />);

    await waitFor(() => {
      expect(screen.getByText('NITTE T-Shirt')).toBeInTheDocument();
      expect(screen.getByText('NITTE Mug')).toBeInTheDocument();
    });

    // Check pricing formatting
    expect(screen.getByText('₹500')).toBeInTheDocument();
    
    // Check out of stock rendering
    expect(screen.getByText('Sold out')).toBeInTheDocument();
    expect(screen.getByText('Out of stock')).toBeDisabled();
  });

  it('displays error message on fetch failure', async () => {
    axios.get.mockRejectedValue(new Error('Network Error'));
    render(<ProductList onAddToCart={mockOnAddToCart} />);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load products/i)).toBeInTheDocument();
    });
  });

  it('filters products by search query', async () => {
    axios.get.mockResolvedValue({ data: { data: mockProducts } });
    render(<ProductList onAddToCart={mockOnAddToCart} />);

    await waitFor(() => {
      expect(screen.getByText('NITTE T-Shirt')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search products');
    fireEvent.change(searchInput, { target: { value: 'Mug' } });

    expect(screen.queryByText('NITTE T-Shirt')).not.toBeInTheDocument();
    expect(screen.getByText('NITTE Mug')).toBeInTheDocument();
  });

  it('calls onAddToCart when add button is clicked', async () => {
    axios.get.mockResolvedValue({ data: { data: mockProducts } });
    render(<ProductList onAddToCart={mockOnAddToCart} />);

    await waitFor(() => {
      expect(screen.getByText('NITTE T-Shirt')).toBeInTheDocument();
    });

    const addButtons = screen.getAllByText('Add to cart');
    fireEvent.click(addButtons[0]);

    expect(mockOnAddToCart).toHaveBeenCalledTimes(1);
    expect(mockOnAddToCart).toHaveBeenCalledWith(mockProducts[0]);
  });
});
